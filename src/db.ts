/**
 * Warstwa danych TaniLek oparta na DuckDB.
 *
 * Odpowiada za:
 *  - normalizację dowolnego źródła tabelarycznego (CSV/XLSX z dane.gov.pl lub próbki demo)
 *    do jednolitego, skompresowanego pliku Apache Parquet (ZSTD),
 *  - samonaprawę: brak lub uszkodzenie pliku Parquet => automatyczna odbudowa z próbki CSV,
 *  - wyszukiwanie leków i grupowanie zamienników z wyliczeniem oszczędności.
 *
 * Wszystkie wartości pochodzące od użytkownika trafiają do SQL wyłącznie jako
 * parametry przygotowanych zapytań (prepared statements).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { type DuckDBConnection, DuckDBInstance, type DuckDBPreparedStatement } from "@duckdb/node-api";
import { aliasKey, describeDrug, fuzzyCandidates, resolveAlias, substanceStem } from "./aliases";
import { BUILTIN_OTC, type OtcRecord, type RplProduct } from "./otc";
import type {
  CategoryCounts,
  DataMeta,
  DataSource,
  DrugRecord,
  EquivalentsResult,
  KategoriaFiltr,
  SavingsQuote,
  SearchHit,
  SearchResult,
  Timed,
} from "./types";

/* -------------------------------------------------------------------------- */
/*  Narzędzia ogólne                                                          */
/* -------------------------------------------------------------------------- */

/** Bezpieczny literał tekstowy SQL (używany tylko dla ścieżek plików kontrolowanych przez aplikację). */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** DuckDB akceptuje ukośniki w obu kierunkach, ale `/` jest przenośny między systemami. */
export function toSqlPath(path: string): string {
  return sqlLiteral(path.replaceAll("\\", "/"));
}

/**
 * Sprowadza tekst do postaci porównawczej: małe litery, bez polskich znaków diakrytycznych.
 * Dzięki temu „nadcisnienie” znajdzie „Nadciśnienie”. Odpowiednik SQL: {@link foldSql}.
 */
export function foldText(value: string): string {
  return value.toLowerCase().replaceAll("ł", "l").normalize("NFD").replace(/\p{M}/gu, "");
}

/** Wyrażenie SQL odpowiadające {@link foldText}. */
function foldSql(column: string): string {
  return `strip_accents(replace(lower(coalesce(${column}, '')), 'ł', 'l'))`;
}

/** Zaokrąglenie kwoty do pełnych groszy. */
export function toGrosze(pln: number): number {
  return Math.round(pln * 100);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* -------------------------------------------------------------------------- */
/*  Logika oszczędności (czysta, w pełni testowalna)                          */
/* -------------------------------------------------------------------------- */

/**
 * Porównuje wybrany lek z zamiennikiem.
 *
 * Gdy oba opakowania mają znaną, ale różną liczbę jednostek (np. 30 vs 60 tabletek),
 * dopłata za zamiennik jest przeliczana na wielkość opakowania wybranego leku –
 * pacjent porównuje wtedy koszt tej samej liczby dawek.
 * Wszystkie obliczenia prowadzone są w groszach, aby uniknąć błędów zmiennoprzecinkowych.
 */
export function calculateSavings(selected: DrugRecord, alternative: DrugRecord): SavingsQuote {
  const selectedUnits = selected.liczba_jednostek;
  const altUnits = alternative.liczba_jednostek;
  const normalize =
    selectedUnits !== null && altUnits !== null && selectedUnits > 0 && altUnits > 0 && selectedUnits !== altUnits;

  const selectedGrosze = toGrosze(selected.doplata_pacjenta);
  const comparableGrosze = normalize
    ? Math.round((toGrosze(alternative.doplata_pacjenta) / (altUnits as number)) * (selectedUnits as number))
    : toGrosze(alternative.doplata_pacjenta);
  const savingsGrosze = selectedGrosze - comparableGrosze;

  return {
    lek: alternative,
    jest_wybranym: alternative.id === selected.id,
    doplata_porownawcza: comparableGrosze / 100,
    oszczednosc_pln: savingsGrosze / 100,
    oszczednosc_proc: selectedGrosze > 0 ? round((savingsGrosze / selectedGrosze) * 100, 1) : 0,
    przeliczono_na_opakowanie: normalize,
  };
}

/**
 * Buduje pełne zestawienie grupy zamienników: wszystkie pozycje posortowane
 * od najniższej (porównawczej) dopłaty, najlepszą ofertę inną niż wybrany lek oraz
 * wskazanie refundacyjne i opis substancji („na co pomaga i jak stosować”) wybranego leku.
 */
export function buildEquivalents(selected: DrugRecord, group: DrugRecord[]): EquivalentsResult {
  const members = group.some((d) => d.id === selected.id) ? group : [selected, ...group];
  const zamienniki = members
    .map((drug) => calculateSavings(selected, drug))
    .sort(
      (a, b) =>
        a.doplata_porownawcza - b.doplata_porownawcza ||
        Number(b.jest_wybranym) - Number(a.jest_wybranym) ||
        a.lek.nazwa.localeCompare(b.lek.nazwa, "pl") ||
        a.lek.id - b.lek.id,
    );
  const best = zamienniki.find((q) => !q.jest_wybranym && q.oszczednosc_pln > 0) ?? null;
  const sredniaCena = groupAveragePrice(zamienniki);
  return {
    wybrany: selected,
    wskazanie: selected.wskazanie ?? "",
    opisSubstancji: describeDrug(selected),
    zamienniki,
    najlepsza_oferta: best,
    sredniaCena,
    liczbaWGrupie: zamienniki.length,
    roznicaDoSredniej: (toGrosze(selected.doplata_pacjenta) - toGrosze(sredniaCena)) / 100,
  };
}

/**
 * Średnia cena w grupie zamienników (PLN, zaokrąglona do groszy) – średnia dopłat porównawczych,
 * czyli przeliczonych na wielkość opakowania wybranego leku. Liczona w groszach; 0 dla pustej grupy.
 */
export function groupAveragePrice(quotes: readonly Pick<SavingsQuote, "doplata_porownawcza">[]): number {
  if (quotes.length === 0) return 0;
  const sum = quotes.reduce((acc, q) => acc + toGrosze(q.doplata_porownawcza), 0);
  return Math.round(sum / quotes.length) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Normalizacja źródła -> Parquet                                            */
/* -------------------------------------------------------------------------- */

export const CANONICAL_COLUMNS = [
  "nazwa",
  "substancja_czynna",
  "dawka",
  "postac",
  "opakowanie",
  "kod_ean",
  "poziom_odplatnosci",
  "doplata_pacjenta",
  "cena_detaliczna",
  "wskazanie",
] as const;

export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

/**
 * Kolumny opcjonalne źródła (v1.2.0): kod ATC oraz kategoria dostępności („Rp”/„OTC”).
 * Nie są wymagane – obwieszczenie MZ ich nie zawiera (ATC uzupełniane jest z rejestru RPL po EAN).
 */
export const OPTIONAL_COLUMNS = ["kod_atc", "kategoria_dostepnosci"] as const;

export type SourceColumn = CanonicalColumn | (typeof OPTIONAL_COLUMNS)[number];

export interface ColumnMapping {
  /** Nazwa kolumny źródłowej dla każdej kolumny kanonicznej. */
  columns: Partial<Record<SourceColumn, string>>;
  /**
   * True, gdy kolumna `nazwa` ma format obwieszczenia MZ: „Nazwa, postać, dawka”
   * (np. „Atoris, tabl. powl., 20 mg”) i postać/dawkę trzeba z niej wyodrębnić.
   */
  combinedName: boolean;
}

export const REQUIRED_COLUMNS: readonly CanonicalColumn[] = ["nazwa", "substancja_czynna", "doplata_pacjenta"];

export class SourceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFormatError";
  }
}

function foldHeader(header: string): string {
  return foldText(header)
    .replace(/[_\-.,;:()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type HeaderRule = (h: string) => boolean;

/** Reguły rozpoznawania nagłówków – zarówno kanonicznych, jak i tych z obwieszczenia MZ. */
const HEADER_RULES: ReadonlyArray<[SourceColumn, HeaderRule]> = [
  ["substancja_czynna", (h) => h.includes("substancj")],
  ["nazwa", (h) => h.startsWith("nazwa") || h.includes("nazwa handlowa") || h.includes("nazwa postac")],
  ["postac", (h) => h.startsWith("postac")],
  ["dawka", (h) => h.startsWith("dawka") || h === "moc" || h.startsWith("moc ")],
  ["opakowanie", (h) => h.includes("opakowan") || h.includes("zawartosc")],
  ["kod_ean", (h) => /\b(ean|gtin)\b/.test(h) || h.startsWith("identyfikator")],
  ["poziom_odplatnosci", (h) => h.includes("poziom odplatnosci") || h === "odplatnosc"],
  ["doplata_pacjenta", (h) => h.includes("doplat")],
  ["cena_detaliczna", (h) => h.includes("cena detaliczna")],
  ["wskazanie", (h) => h.includes("wskazan") && !h.includes("pozarejestr")],
  ["kod_atc", (h) => /\batc\b/.test(h)],
  ["kategoria_dostepnosci", (h) => h.includes("kategoria dostepnosci") || h === "dostepnosc"],
];

/** Dopasowuje nagłówki źródła do kolumn kanonicznych. Każda kolumna źródłowa użyta jest co najwyżej raz. */
export function mapSourceColumns(headers: readonly string[]): ColumnMapping {
  const columns: Partial<Record<SourceColumn, string>> = {};
  const used = new Set<string>();
  for (const [canonical, rule] of HEADER_RULES) {
    for (const header of headers) {
      if (used.has(header)) continue;
      if (rule(foldHeader(header))) {
        columns[canonical] = header;
        used.add(header);
        break;
      }
    }
  }
  const nameHeader = columns.nazwa ? foldHeader(columns.nazwa) : "";
  const combinedName =
    columns.nazwa !== undefined &&
    columns.postac === undefined &&
    columns.dawka === undefined &&
    (nameHeader.includes("postac") || nameHeader.includes("dawk"));
  return { columns, combinedName };
}

export function missingRequired(mapping: ColumnMapping): CanonicalColumn[] {
  return REQUIRED_COLUMNS.filter((c) => mapping.columns[c] === undefined);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Wyrażenie SQL zamieniające polski zapis kwoty („12,50 zł”) na DOUBLE. */
function priceSql(column: string): string {
  return `TRY_CAST(replace(regexp_replace(trim(${column}), '[^0-9,.\\-]', '', 'g'), ',', '.') AS DOUBLE)`;
}

/** Buduje znormalizowane zapytanie SELECT na podstawie mapowania kolumn tabeli `zrodlo`. */
export function buildNormalizedSelect(mapping: ColumnMapping, sourceTable = "zrodlo"): string {
  const col = (c: SourceColumn) => {
    const header = mapping.columns[c];
    return header === undefined ? null : `CAST(${quoteIdent(header)} AS VARCHAR)`;
  };
  const text = (c: SourceColumn) => {
    const expr = col(c);
    return expr === null ? "''" : `trim(regexp_replace(coalesce(${expr}, ''), '\\s+', ' ', 'g'))`;
  };

  /*
   * Kolumna łączona z obwieszczenia MZ: „Nazwa, postać[, …], dawka[, dawka]”, np.
   *   „Rigevidon, tabl. powl., 0,03+0,15 mg”, „Aprepitant Stada, kaps. twarde, 125 mg, 80 mg”,
   *   „Daivobet, żel, (50 µg+0,5 mg)/g”, „Arexvy, proszek i zawiesina do …” (bez dawki).
   * Separatorem jest przecinek ze spacją (przecinki dziesiętne jej nie mają), a dawka zaczyna się
   * od pierwszego członu (po nazwie) rozpoczynającego się cyfrą lub „(cyfrą”.
   */
  const rawName = text("nazwa");
  const parts = `regexp_split_to_array(${rawName}, '[[:space:]]*,[[:space:]]+')`;
  const doseIdx = `list_position(list_transform((${parts})[2:], lambda x: regexp_matches(x, '^[(]?[0-9]')), true)`;
  const nazwa = mapping.combinedName ? `trim((${parts})[1])` : rawName;
  const postac = mapping.combinedName
    ? `CASE WHEN ${doseIdx} IS NULL THEN array_to_string((${parts})[2:], ', ')
            ELSE array_to_string((${parts})[2:${doseIdx}], ', ') END`
    : text("postac");
  const dawka = mapping.combinedName
    ? `CASE WHEN ${doseIdx} IS NULL THEN '' ELSE array_to_string((${parts})[${doseIdx} + 1:], ', ') END`
    : text("dawka");
  const doplata = col("doplata_pacjenta");
  const cena = col("cena_detaliczna");

  return `
    WITH znormalizowane AS (
      SELECT
        ${nazwa} AS nazwa,
        ${text("substancja_czynna")} AS substancja_czynna,
        ${dawka} AS dawka,
        ${postac} AS postac,
        ${text("opakowanie")} AS opakowanie,
        -- Excel zapisuje kody jako liczby („5909990012345.0”), a GTIN-14 ma wiodące zero.
        regexp_replace(regexp_replace(${text("kod_ean")}, '\\.0+$', ''), '^0(\\d{13})$', '\\1') AS kod_ean,
        ${text("poziom_odplatnosci")} AS poziom_odplatnosci,
        ${doplata === null ? "NULL::DOUBLE" : priceSql(doplata)} AS doplata_pacjenta,
        ${cena === null ? "NULL::DOUBLE" : priceSql(cena)} AS cena_detaliczna,
        ${text("wskazanie")} AS wskazanie,
        ${mapping.columns.kod_atc === undefined ? "NULL::VARCHAR" : `nullif(upper(regexp_replace(${text("kod_atc")}, '\\s+', '', 'g')), '')`} AS kodAtc,
        ${mapping.columns.kategoria_dostepnosci === undefined ? "'Rp'" : `CASE WHEN upper(${text("kategoria_dostepnosci")}) = 'OTC' THEN 'OTC' ELSE 'Rp' END`} AS kategoriaDostepnosci,
        _rn
      FROM ${sourceTable}
    )
    SELECT
      CAST(row_number() OVER (ORDER BY _rn) AS INTEGER) AS id,
      nazwa,
      substancja_czynna,
      dawka,
      postac,
      opakowanie,
      -- Inhalatory („1 inh.po 60 daw.”) liczymy w dawkach, pozostałe opakowania w sztukach.
      coalesce(
        TRY_CAST(regexp_extract(lower(opakowanie), '(\\d+)\\s*daw', 1) AS INTEGER),
        TRY_CAST(regexp_extract(
          lower(opakowanie),
          '(\\d+)\\s*(szt|tabl|kaps|sasz|amp|fiol|wstrz|wkł|wkl|plast|czop|tab|draż|draz|pastyl|wkładek|wkladek)',
          1
        ) AS INTEGER)
      ) AS liczba_jednostek,
      kod_ean,
      poziom_odplatnosci,
      round(doplata_pacjenta, 2) AS doplata_pacjenta,
      round(coalesce(cena_detaliczna, doplata_pacjenta), 2) AS cena_detaliczna,
      wskazanie,
      kategoriaDostepnosci,
      kategoriaDostepnosci = 'Rp' AS czyRefundowany,
      kodAtc
    FROM znormalizowane
    WHERE nazwa <> '' AND substancja_czynna <> '' AND doplata_pacjenta IS NOT NULL AND doplata_pacjenta >= 0
    ORDER BY _rn`;
}

export type SourceKind = "csv" | "xlsx";

export interface BuildParquetOptions {
  inputPath: string;
  kind: SourceKind;
  parquetPath: string;
  meta: Omit<DataMeta, "rows" | "built_at">;
  /** Minimalna liczba poprawnych wierszy wymagana do uznania źródła za prawidłowe. */
  minRows?: number;
}

/** Liczba początkowych wierszy przeszukiwanych w poszukiwaniu wiersza nagłówka. */
const HEADER_SCAN_ROWS = 30;

/**
 * Jawny zakres arkusza. Bez niego `read_xlsx` wnioskuje szerokość tabeli z pierwszego
 * wiersza – a w obwieszczeniu MZ jest to jednokomórkowy tytuł sekcji („A 1. Leki refundowane…”).
 * Puste kolumny są pomijane przy mapowaniu nagłówków.
 */
const XLSX_RANGE = "A1:AZ1048576";

async function loadRawSource(
  conn: DuckDBConnection,
  inputPath: string,
  kind: SourceKind,
  sheet?: string,
): Promise<void> {
  if (kind === "xlsx") {
    // Rozszerzenie `excel` pobierane jest z repozytorium DuckDB przy pierwszym użyciu.
    await conn.run("INSTALL excel; LOAD excel;");
    const sheetArg = sheet === undefined ? "" : `, sheet = ${sqlLiteral(sheet)}`;
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE surowe AS
       SELECT row_number() OVER () AS _rn, *
       FROM read_xlsx(${toSqlPath(inputPath)}, header = false, all_varchar = true, ignore_errors = true,
                      range = '${XLSX_RANGE}', stop_at_empty = false${sheetArg})`,
    );
  } else {
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE surowe AS
       SELECT row_number() OVER () AS _rn, *
       FROM read_csv(${toSqlPath(inputPath)}, header = false, all_varchar = true, sample_size = -1,
                     null_padding = true, ignore_errors = true, parallel = false)`,
    );
  }
  await removeEmptyRows(conn);
}

/**
 * Usuwa wiersze, w których wszystkie komórki są puste. Jawny zakres arkusza (`stop_at_empty = false`)
 * zwraca wszystkie ~1 mln wierszy arkusza; nie używamy `stop_at_empty = true`, bo pusty wiersz
 * między sekcjami obwieszczenia ucinałby po cichu resztę danych.
 */
async function removeEmptyRows(conn: DuckDBConnection): Promise<void> {
  const described = await conn.runAndReadAll("DESCRIBE surowe");
  const columns = (described.getRowObjectsJson() as { column_name: string }[])
    .map((r) => r.column_name)
    .filter((c) => c !== "_rn");
  if (columns.length === 0) return;
  const allEmpty = columns.map((c) => `nullif(trim(${quoteIdent(c)}), '') IS NULL`).join(" AND ");
  await conn.run(`DELETE FROM surowe WHERE ${allEmpty}`);
}

interface DetectedHeader {
  /** Numer (`_rn`) wiersza nagłówka w tabeli `surowe`. */
  headerRn: number;
  rawColumns: string[];
  labels: string[];
  mapping: ColumnMapping;
}

/**
 * Szuka wiersza nagłówka w pierwszych wierszach tabeli `surowe`
 * (pliki z obwieszczeń często mają nad tabelą tytuł). `header` jest `null`, gdy go brak.
 */
async function detectHeader(conn: DuckDBConnection): Promise<{ header: DetectedHeader | null; scanned: number }> {
  const head = await conn.runAndReadAll(`SELECT * FROM surowe ORDER BY _rn LIMIT ${HEADER_SCAN_ROWS}`);
  const rawColumns = head.columnNames().filter((c) => c !== "_rn");
  const rows = head.getRowObjectsJson() as Record<string, unknown>[];

  for (const row of rows) {
    const headers = rawColumns.map((c, i) => {
      const value = row[c];
      const label = typeof value === "string" ? value.trim() : "";
      return label === "" ? `kolumna_${i + 1}` : label;
    });
    // Unikalne etykiety (w obwieszczeniach zdarzają się powtórzenia nagłówków).
    const seen = new Map<string, number>();
    const labels = headers.map((h) => {
      const n = (seen.get(h) ?? 0) + 1;
      seen.set(h, n);
      return n === 1 ? h : `${h} (${n})`;
    });
    const mapping = mapSourceColumns(labels);
    if (missingRequired(mapping).length > 0) continue;
    return { header: { headerRn: Number(row._rn), rawColumns, labels, mapping }, scanned: rows.length };
  }
  return { header: null, scanned: rows.length };
}

/**
 * Wczytuje surowy plik bez założeń o nagłówku, wyszukuje wiersz nagłówka,
 * mapuje kolumny i tworzy tabelę `zrodlo` z czytelnymi nazwami kolumn.
 */
async function prepareSourceTable(conn: DuckDBConnection, inputPath: string, kind: SourceKind): Promise<ColumnMapping> {
  await loadRawSource(conn, inputPath, kind);
  const { header, scanned } = await detectHeader(conn);
  if (header === null) {
    throw new SourceFormatError(
      `Nie rozpoznano struktury pliku – wymagane kolumny: ${REQUIRED_COLUMNS.join(", ")}. ` +
        `Sprawdzono ${scanned} pierwszych wierszy.`,
    );
  }
  const { rawColumns, labels, headerRn, mapping } = header;
  const selectList = rawColumns.map((c, i) => `${quoteIdent(c)} AS ${quoteIdent(labels[i] as string)}`).join(", ");
  await conn.run(`CREATE TEMP TABLE zrodlo AS SELECT _rn, ${selectList} FROM surowe WHERE _rn > ${headerRn}`);
  return mapping;
}

/* -------------------------------------------------------------------------- */
/*  Konwersja XLSX → CSV                                                      */
/* -------------------------------------------------------------------------- */

/** Odczytuje wskazany plik z archiwum ZIP (np. XLSX) na podstawie katalogu centralnego. */
export function readZipEntry(zip: Uint8Array, entryName: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Rekord końca katalogu centralnego (EOCD) leży w ostatnich 22 + 65535 bajtach pliku.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceFormatError("Plik XLSX nie jest poprawnym archiwum ZIP.");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < entries && offset + 46 <= zip.length; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    if (name === entryName) {
      const dataStart =
        localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new SourceFormatError(`Nieobsługiwana metoda kompresji ZIP (${method}).`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Zwraca nazwy arkuszy skoroszytu XLSX w kolejności z pliku `xl/workbook.xml`. */
export function listXlsxSheets(xlsx: Uint8Array): string[] {
  const workbook = readZipEntry(xlsx, "xl/workbook.xml");
  if (workbook === null) throw new SourceFormatError("Brak pliku xl/workbook.xml – to nie jest skoroszyt XLSX.");
  const xml = new TextDecoder().decode(workbook);
  return [...xml.matchAll(/<(?:\w+:)?sheet\b[^>]*?\bname="([^"]*)"/g)].map((m) => decodeXmlEntities(m[1] as string));
}

/**
 * Konwertuje pierwszy arkusz skoroszytu zawierający tabelę leków (rozpoznany wiersz nagłówka
 * z wymaganymi kolumnami) do pliku CSV w UTF-8. Zachowuje oryginalny układ wierszy
 * (łącznie z tytułem nad tabelą) – nagłówek wykrywa potem `buildParquet`. Zwraca nazwę arkusza.
 */
export async function convertXlsxToCsv(xlsxPath: string, csvPath: string): Promise<string> {
  const sheets = listXlsxSheets(new Uint8Array(await readFile(xlsxPath)));
  if (sheets.length === 0) throw new SourceFormatError("Skoroszyt XLSX nie zawiera arkuszy.");
  await mkdir(dirname(csvPath), { recursive: true });

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    for (const sheet of sheets) {
      await loadRawSource(conn, xlsxPath, "xlsx", sheet);
      const { header } = await detectHeader(conn);
      if (header === null) continue;
      await conn.run(
        `COPY (SELECT * EXCLUDE (_rn) FROM surowe ORDER BY _rn) TO ${toSqlPath(csvPath)} (FORMAT CSV, HEADER false)`,
      );
      return sheet;
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  throw new SourceFormatError(
    `Żaden arkusz XLSX (${sheets.join(", ")}) nie zawiera tabeli leków – wymagane kolumny: ${REQUIRED_COLUMNS.join(", ")}.`,
  );
}

export function metaPathFor(parquetPath: string): string {
  return `${parquetPath}.meta.json`;
}

/**
 * Normalizuje źródło CSV/XLSX i zapisuje je jako Parquet (ZSTD).
 * Zapis odbywa się do pliku tymczasowego, a następnie atomowo podmienia plik docelowy,
 * więc działający serwer nigdy nie zobaczy w połowie zapisanego pliku.
 */
export async function buildParquet(options: BuildParquetOptions): Promise<DataMeta> {
  const { inputPath, kind, parquetPath, minRows = 1 } = options;
  if (!existsSync(inputPath)) {
    throw new SourceFormatError(`Plik źródłowy nie istnieje: ${inputPath}`);
  }
  await mkdir(dirname(parquetPath), { recursive: true });
  const tmpPath = `${parquetPath}.tmp-${process.pid}-${Date.now()}`;

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const mapping = await prepareSourceTable(conn, inputPath, kind);
    await conn.run(
      `COPY (${buildNormalizedSelect(mapping)}) TO ${toSqlPath(tmpPath)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
    );
    const countReader = await conn.runAndReadAll(
      `SELECT CAST(count(*) AS INTEGER) AS n FROM read_parquet(${toSqlPath(tmpPath)})`,
    );
    const rows = Number((countReader.getRowObjectsJson()[0] as { n: number }).n);
    if (rows < minRows) {
      throw new SourceFormatError(`Po normalizacji pozostało ${rows} wierszy (wymagane minimum: ${minRows}).`);
    }
    await rename(tmpPath, parquetPath);
    const meta: DataMeta = { ...options.meta, rows, built_at: new Date().toISOString() };
    await writeFile(metaPathFor(parquetPath), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return meta;
  } finally {
    conn.closeSync();
    instance.closeSync();
    await rm(tmpPath, { force: true });
  }
}

/**
 * Buduje plik Parquet z dołączonej próbki CSV (tryb demo / awaryjny) i dołącza wbudowany
 * zestaw popularnych leków bez recepty ({@link BUILTIN_OTC}).
 */
export async function buildFromFallback(fallbackCsvPath: string, parquetPath: string): Promise<DataMeta> {
  const meta = await buildParquet({
    inputPath: fallbackCsvPath,
    kind: "csv",
    parquetPath,
    meta: { source: "fallback-demo", resource_url: null, resource_title: "Próbka demonstracyjna (35 leków)" },
  });
  return mergeCatalog({
    refundedParquet: parquetPath,
    parquetPath,
    otc: BUILTIN_OTC,
    otcSource: "builtin",
    meta: { source: meta.source, resource_url: meta.resource_url, resource_title: meta.resource_title },
  });
}

/** Kolumny wymagane w pliku Parquet (schemat v1.1.0 – starsze pliki pozostają poprawne). */
const REQUIRED_PARQUET_COLUMNS = ["id", ...CANONICAL_COLUMNS, "liczba_jednostek"];

/** Kolumny dodane w v1.2.0 wraz z wartościami domyślnymi dla plików w starszym schemacie. */
const V12_COLUMN_DEFAULTS: Readonly<Record<string, string>> = {
  kategoriaDostepnosci: "'Rp'",
  czyRefundowany: "true",
  kodAtc: "NULL::VARCHAR",
};

/** Kolumny rekordu leku w kolejności zapisu w Parquet. */
const RECORD_COLUMNS = [
  "id",
  "nazwa",
  "substancja_czynna",
  "dawka",
  "postac",
  "opakowanie",
  "liczba_jednostek",
  "kod_ean",
  "poziom_odplatnosci",
  "doplata_pacjenta",
  "cena_detaliczna",
  "wskazanie",
  "kategoriaDostepnosci",
  "czyRefundowany",
  "kodAtc",
] as const;

/**
 * Lista SELECT nad plikiem Parquet: brakujące kolumny v1.2.0 (np. w pliku z v1.1.0) zastępowane są
 * wartościami domyślnymi – „Rp”, refundowany, brak kodu ATC.
 */
async function parquetSelectList(conn: DuckDBConnection, parquetPath: string): Promise<string> {
  const reader = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${toSqlPath(parquetPath)})`);
  const names = new Set((reader.getRowObjectsJson() as { column_name: string }[]).map((r) => r.column_name));
  return RECORD_COLUMNS.map((c) => {
    if (names.has(c)) return quoteIdent(c);
    const fallback = V12_COLUMN_DEFAULTS[c];
    if (fallback === undefined) throw new SourceFormatError(`Plik Parquet nie zawiera kolumny ${c}.`);
    return `${fallback} AS ${quoteIdent(c)}`;
  }).join(", ");
}

export interface MergeCatalogOptions {
  /** Plik Parquet z lekami refundowanymi (może być tym samym plikiem co `parquetPath`). */
  refundedParquet: string;
  /** Plik wynikowy. */
  parquetPath: string;
  /** Leki bez recepty do dołączenia. */
  otc: readonly OtcRecord[];
  otcSource: "rpl" | "builtin";
  /** Mapa EAN → kod ATC (z RPL) uzupełniająca brakujące kody ATC leków refundowanych. */
  atcByEan?: ReadonlyMap<string, string>;
  meta: Omit<DataMeta, "rows" | "built_at" | "rows_rp" | "rows_otc" | "otc_source">;
}

/**
 * Scala leki refundowane (Rp) z lekami bez recepty (OTC) w jeden plik Parquet:
 *  - wcześniejsze pozycje OTC z pliku wejściowego są pomijane (zastępuje je nowy zestaw),
 *  - brakujące kody ATC leków Rp są uzupełniane z RPL po kodzie EAN,
 *  - pozycja OTC o EAN obecnym już w wykazie refundacyjnym jest pomijana (pierwszeństwo ma cena urzędowa),
 *  - identyfikatory: najpierw leki Rp (w dotychczasowej kolejności), potem OTC.
 * Zapis jest atomowy (plik tymczasowy + rename), jak w {@link buildParquet}.
 */
export async function mergeCatalog(options: MergeCatalogOptions): Promise<DataMeta> {
  const { refundedParquet, parquetPath } = options;
  const tmpDir = `${parquetPath}.merge-${process.pid}-${Date.now()}`;
  const tmpParquet = `${tmpDir}/leki.parquet`;
  await mkdir(tmpDir, { recursive: true });

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const selectList = await parquetSelectList(conn, refundedParquet);
    await conn.run(
      `CREATE TABLE rp AS SELECT * FROM (SELECT ${selectList} FROM read_parquet(${toSqlPath(refundedParquet)}))
       WHERE coalesce(kategoriaDostepnosci, 'Rp') = 'Rp' ORDER BY id`,
    );

    if (options.atcByEan && options.atcByEan.size > 0) {
      const atcPath = `${tmpDir}/atc.jsonl`;
      const lines = [...options.atcByEan].map(([ean, atc]) => JSON.stringify({ ean, atc }));
      await writeFile(atcPath, `${lines.join("\n")}\n`, "utf8");
      await conn.run(
        `CREATE TABLE atc AS SELECT * FROM read_json(${toSqlPath(atcPath)}, format = 'newline_delimited',
           columns = {ean: 'VARCHAR', atc: 'VARCHAR'})`,
      );
      await conn.run(
        `UPDATE rp SET kodAtc = atc.atc FROM atc WHERE rp.kod_ean = atc.ean AND (rp.kodAtc IS NULL OR rp.kodAtc = '')`,
      );
    }

    const otcPath = `${tmpDir}/otc.jsonl`;
    const otcLines = options.otc.map((r, i) => JSON.stringify({ ...r, _ord: i }));
    await writeFile(otcPath, otcLines.length > 0 ? `${otcLines.join("\n")}\n` : "", "utf8");
    await conn.run(`
      CREATE TABLE otc (nazwa VARCHAR, substancja_czynna VARCHAR, dawka VARCHAR, postac VARCHAR,
        opakowanie VARCHAR, liczba_jednostek INTEGER, kod_ean VARCHAR, cena DOUBLE, kodAtc VARCHAR, _ord INTEGER)`);
    if (otcLines.length > 0) {
      await conn.run(
        `INSERT INTO otc SELECT nazwa, substancja_czynna, dawka, postac, opakowanie, liczba_jednostek, kod_ean, cena,
           kodAtc, _ord
         FROM read_json(${toSqlPath(otcPath)}, format = 'newline_delimited', columns = {
           nazwa: 'VARCHAR', substancja_czynna: 'VARCHAR', dawka: 'VARCHAR', postac: 'VARCHAR', opakowanie: 'VARCHAR',
           liczba_jednostek: 'INTEGER', kod_ean: 'VARCHAR', cena: 'DOUBLE', kodAtc: 'VARCHAR', _ord: 'INTEGER'})`,
      );
    }

    await conn.run(`
      COPY (
        WITH polaczone AS (
          SELECT 0 AS _zrodlo, id AS _ord, nazwa, substancja_czynna, dawka, postac, opakowanie, liczba_jednostek,
                 kod_ean, poziom_odplatnosci, doplata_pacjenta, cena_detaliczna, wskazanie,
                 'Rp' AS kategoriaDostepnosci, true AS czyRefundowany, nullif(kodAtc, '') AS kodAtc
          FROM rp
          UNION ALL
          SELECT 1, _ord, nazwa, substancja_czynna, coalesce(dawka, ''), coalesce(postac, ''), coalesce(opakowanie, ''),
                 liczba_jednostek, coalesce(kod_ean, ''), 'pełna odpłatność (bez recepty)', round(cena, 2),
                 round(cena, 2), '', 'OTC', false, nullif(kodAtc, '')
          FROM otc
          WHERE cena IS NOT NULL AND cena >= 0
            AND (coalesce(kod_ean, '') = '' OR kod_ean NOT IN (SELECT kod_ean FROM rp WHERE kod_ean <> ''))
        )
        SELECT CAST(row_number() OVER (ORDER BY _zrodlo, _ord) AS INTEGER) AS id,
               nazwa, substancja_czynna, dawka, postac, opakowanie, liczba_jednostek, kod_ean, poziom_odplatnosci,
               doplata_pacjenta, cena_detaliczna, wskazanie, kategoriaDostepnosci, czyRefundowany, kodAtc
        FROM polaczone
        ORDER BY id
      ) TO ${toSqlPath(tmpParquet)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`);

    const counts = await conn.runAndReadAll(
      `SELECT CAST(count(*) FILTER (WHERE kategoriaDostepnosci = 'Rp') AS INTEGER) AS rp,
              CAST(count(*) FILTER (WHERE kategoriaDostepnosci = 'OTC') AS INTEGER) AS otc
       FROM read_parquet(${toSqlPath(tmpParquet)})`,
    );
    const { rp, otc } = counts.getRowObjectsJson()[0] as { rp: number; otc: number };
    await rename(tmpParquet, parquetPath);
    const meta: DataMeta = {
      ...options.meta,
      rows: Number(rp) + Number(otc),
      rows_rp: Number(rp),
      rows_otc: Number(otc),
      otc_source: options.otcSource,
      built_at: new Date().toISOString(),
    };
    await writeFile(metaPathFor(parquetPath), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return meta;
  } finally {
    conn.closeSync();
    instance.closeSync();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Kolumny eksportu CSV Rejestru Produktów Leczniczych używane przez TaniLek. */
const RPL_COLUMNS: Readonly<Record<keyof RplProduct, string>> = {
  nazwa: "Nazwa Produktu Leczniczego",
  substancja: "Nazwa powszechnie stosowana",
  rodzaj: "Rodzaj preparatu",
  moc: "Moc",
  postac: "Postać farmaceutyczna",
  kodAtc: "Kod ATC",
  opakowanie: "Opakowanie",
  waznosc: "Ważność pozwolenia",
};

/**
 * Wczytuje eksport CSV z RPL (separator „;”, pola wieloliniowe w cudzysłowach) przez DuckDB
 * i zwraca wiersze produktów. Rzuca {@link SourceFormatError}, gdy brak wymaganych kolumn.
 */
export async function readRplCsv(csvPath: string): Promise<RplProduct[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `CREATE TABLE rpl AS SELECT * FROM read_csv(${toSqlPath(csvPath)}, delim = ';', quote = '"', escape = '"',
         header = true, all_varchar = true, max_line_size = 10000000, strict_mode = false, parallel = false)`,
    );
    const described = await conn.runAndReadAll("DESCRIBE rpl");
    const names = new Set((described.getRowObjectsJson() as { column_name: string }[]).map((r) => r.column_name));
    const missing = Object.values(RPL_COLUMNS).filter((c) => !names.has(c));
    if (missing.length > 0) {
      throw new SourceFormatError(`Eksport RPL nie zawiera kolumn: ${missing.join(", ")}.`);
    }
    const select = Object.entries(RPL_COLUMNS)
      .map(([key, column]) => `${quoteIdent(column)} AS ${quoteIdent(key)}`)
      .join(", ");
    const reader = await conn.runAndReadAll(`SELECT ${select} FROM rpl`);
    return reader.getRowObjectsJson() as unknown as RplProduct[];
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/** Sprawdza, czy istniejący plik Parquet jest czytelny i ma oczekiwany schemat. */
export async function isValidParquet(parquetPath: string): Promise<boolean> {
  if (!existsSync(parquetPath)) return false;
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const reader = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${toSqlPath(parquetPath)})`);
    const names = new Set((reader.getRowObjectsJson() as { column_name: string }[]).map((r) => r.column_name));
    return REQUIRED_PARQUET_COLUMNS.every((c) => names.has(c));
  } catch {
    return false;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

async function readMeta(parquetPath: string): Promise<DataMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPathFor(parquetPath), "utf8")) as DataMeta;
    return typeof parsed.source === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export interface EnsureDataOptions {
  dataFilePath: string;
  fallbackCsvPath: string;
  log?: (message: string) => void;
}

/**
 * Gwarantuje istnienie poprawnego pliku Parquet. Gdy go brak lub jest uszkodzony,
 * buduje go z próbki CSV – aplikacja zawsze startuje jako działające demo.
 */
export async function ensureDataFile(options: EnsureDataOptions): Promise<DataMeta> {
  const log = options.log ?? (() => {});
  if (await isValidParquet(options.dataFilePath)) {
    const meta = await readMeta(options.dataFilePath);
    if (meta) return meta;
    return {
      source: "parquet",
      resource_url: null,
      resource_title: null,
      built_at: new Date().toISOString(),
      rows: -1,
    };
  }
  log(`Brak poprawnego pliku ${options.dataFilePath} – buduję bazę demo z ${options.fallbackCsvPath}.`);
  return buildFromFallback(options.fallbackCsvPath, options.dataFilePath);
}

/* -------------------------------------------------------------------------- */
/*  Baza zapytań w czasie działania                                           */
/* -------------------------------------------------------------------------- */

const DRUG_COLUMNS =
  "id, nazwa, substancja_czynna, dawka, postac, opakowanie, liczba_jednostek, kod_ean, " +
  "poziom_odplatnosci, doplata_pacjenta, cena_detaliczna, wskazanie, kategoriaDostepnosci, czyRefundowany, kodAtc";

/** Kolumny wyniku wyszukiwania: rekord leku + statystyki grupy zamienników. */
const HIT_COLUMNS = `${DRUG_COLUMNS}, liczba_zamiennikow, najnizsza_doplata_w_grupie, mozliwa_oszczednosc, sredniaCena, liczbaWGrupie`;

/**
 * Klucz grupy zamienników: ta sama kategoria dostępności, substancja czynna, dawka i postać.
 * Leki Rp (cena urzędowa) i OTC (cena orientacyjna) tworzą osobne grupy – nie porównujemy
 * dopłaty refundacyjnej z szacunkiem ceny rynkowej.
 */
const GROUP_KEY_SQL = `
  kategoriaDostepnosci || '|' ||
  ${foldSql("substancja_czynna")} || '|' ||
  replace(replace(lower(coalesce(dawka, '')), ' ', ''), ',', '.') || '|' ||
  regexp_replace(${foldSql("postac")}, 's+', ' ', 'g')`;

/**
 * Jednorazowa materializacja przy starcie: widok `leki_zrodlo` (nad plikiem Parquet) jest
 * kopiowany do kolumnowej tabeli w pamięci razem z wyliczonymi z góry kolumnami pomocniczymi:
 * tekstem do wyszukiwania, kluczem grupy zamienników i statystyką grupy dla każdej pozycji
 * (liczba zamienników, najniższa i średnia dopłata, możliwa oszczędność).
 * Dzięki temu zapytanie użytkownika to pojedynczy, filtrowany skan bez złączeń.
 */
const MATERIALIZE_SQL = `
  CREATE OR REPLACE TABLE leki AS
  WITH baza AS (
    SELECT ${DRUG_COLUMNS},
      ${foldSql("nazwa")} AS _nazwa_f,
      ${foldSql("substancja_czynna")} AS _subst_f,
      ${foldSql("wskazanie")} AS _wsk_f,
      split_part(${foldSql("nazwa")}, ' ', 1) AS _nazwa_w1,
      split_part(${foldSql("substancja_czynna")}, ' ', 1) AS _subst_w1,
      ${GROUP_KEY_SQL} AS _grupa
    FROM leki_zrodlo
  ),
  porownanie AS (
    SELECT
      t.id,
      CAST(count(o.id) - 1 AS INTEGER) AS liczba_zamiennikow,
      round(min(o.doplata_pacjenta), 2) AS najnizsza_doplata_w_grupie,
      round(greatest(0, any_value(t.doplata_pacjenta) - min(
        CASE
          WHEN t.liczba_jednostek > 0 AND o.liczba_jednostek > 0 AND t.liczba_jednostek <> o.liczba_jednostek
            THEN o.doplata_pacjenta / o.liczba_jednostek * t.liczba_jednostek
          ELSE o.doplata_pacjenta
        END)), 2) AS mozliwa_oszczednosc,
      -- Średnia dopłat przeliczonych na wielkość opakowania tego leku (jak w buildEquivalents).
      round(avg(
        CASE
          WHEN t.liczba_jednostek > 0 AND o.liczba_jednostek > 0 AND t.liczba_jednostek <> o.liczba_jednostek
            THEN o.doplata_pacjenta / o.liczba_jednostek * t.liczba_jednostek
          ELSE o.doplata_pacjenta
        END), 2) AS sredniaCena,
      CAST(count(o.id) AS INTEGER) AS liczbaWGrupie
    FROM baza t
    JOIN baza o ON o._grupa = t._grupa
    GROUP BY t.id
  )
  SELECT b.*, p.liczba_zamiennikow, p.najnizsza_doplata_w_grupie, p.mozliwa_oszczednosc, p.sredniaCena, p.liczbaWGrupie
  FROM baza b
  JOIN porownanie p USING (id)
  ORDER BY b.id`;

/**
 * Dodaje do tabeli `leki` kolumnę `_opis_f`: złożony tekst karty „Na co pomaga” (etykieta grupy
 * i opis z {@link describeDrug}) oraz wskazanie refundacyjne – bez polskich znaków, małymi literami.
 * Opisy powstają w TypeScripcie (słownik substancji, grupy ATC), więc są liczone raz przy starcie
 * i dopisywane przez appender; powtarzające się kombinacje pól są liczone tylko raz.
 */
async function materializeDescriptions(conn: DuckDBConnection): Promise<void> {
  const reader = await conn.runAndReadAll(
    `SELECT id, nazwa, substancja_czynna, postac, wskazanie, kodAtc, kategoriaDostepnosci FROM leki`,
  );
  const rows = reader.getRowObjectsJson() as unknown as (DescribableRow & { id: number })[];
  await conn.run("CREATE OR REPLACE TEMP TABLE leki_opisy (id INTEGER, opis VARCHAR)");
  const appender = await conn.createAppender("leki_opisy");
  const memo = new Map<string, string>();
  try {
    for (const row of rows) {
      const key = [row.nazwa, row.substancja_czynna, row.postac, row.wskazanie, row.kodAtc, row.kategoriaDostepnosci]
        .map((v) => v ?? "")
        .join("\u0001");
      let opis = memo.get(key);
      if (opis === undefined) {
        const d = describeDrug({
          nazwa: row.nazwa ?? "",
          substancja_czynna: row.substancja_czynna ?? "",
          postac: row.postac ?? "",
          wskazanie: row.wskazanie ?? "",
          kodAtc: row.kodAtc,
          kategoriaDostepnosci: row.kategoriaDostepnosci === "OTC" ? "OTC" : "Rp",
        });
        opis = symptomText(`${d.kategoria}. ${d.naCoPomaga} ${row.wskazanie ?? ""}`);
        memo.set(key, opis);
      }
      appender.appendInteger(Number(row.id));
      appender.appendVarchar(opis);
      appender.endRow();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
  await conn.run(`
    CREATE OR REPLACE TABLE leki AS
    SELECT l.*, coalesce(o.opis, '') AS _opis_f
    FROM leki l LEFT JOIN leki_opisy o ON o.id = l.id
    ORDER BY l.id`);
  await conn.run("DROP TABLE leki_opisy");
}

interface DescribableRow {
  nazwa: string | null;
  substancja_czynna: string | null;
  postac: string | null;
  wskazanie: string | null;
  kodAtc: string | null;
  kategoriaDostepnosci: string | null;
}

/** Warunek filtra kategorii („wszystkie” = bez filtra). */
const CATEGORY_FILTER = `($kategoria = 'wszystkie' OR kategoriaDostepnosci = $kategoria)`;

/** Minimalne podobieństwo Jaro-Winklera dla wyników przybliżonych. */
export const FUZZY_THRESHOLD = 0.82;

/**
 * Rangi trafień w jednym, wspólnym rankingu wyszukiwania (mniejsza = wyżej na liście).
 * Przy dużej bazie (MZ + RPL) kolejność jest kluczowa: najpierw dokładne trafienia nazwy
 * lub aliasu, potem substancja czynna i opis objawów, na końcu wyniki przybliżone.
 */
export const SEARCH_RANK = {
  /** Kod EAN, cała nazwa leku lub pierwsze słowa nazwy równe zapytaniu („Apap” → „Apap Extra”). */
  NAZWA_DOKLADNA: 0,
  /** Zapytanie jest w całości hasłem ze słownika marek/polskich nazw („apap” → Paracetamolum). */
  ALIAS_DOKLADNY: 1,
  /** Nazwa leku zaczyna się od zapytania. */
  NAZWA_PREFIKS: 2,
  /** Nazwa leku zawiera zapytanie. */
  NAZWA_FRAGMENT: 3,
  /** Substancja czynna zaczyna się od zapytania. */
  SUBSTANCJA_PREFIKS: 4,
  /** Substancja czynna zawiera zapytanie. */
  SUBSTANCJA_FRAGMENT: 5,
  /** Substancja rozpoznana ze słowa zapytania lub z polskiej końcówki („atorwastatyna”). */
  ALIAS_SUBSTANCJA: 6,
  /** Opis „Na co pomaga” lub wskazanie refundacyjne pasuje do objawu („katar”, „ból gardła”). */
  OBJAWY: 7,
  /** Podobieństwo Jaro-Winklera ≥ {@link FUZZY_THRESHOLD} (literówki). */
  PRZYBLIZONE: 8,
} as const;

/** Maksymalna liczba słów objawu brana pod uwagę. */
const MAX_SYMPTOM_WORDS = 5;

const SYMPTOM_PARAMS = Array.from({ length: MAX_SYMPTOM_WORDS }, (_, i) => `o${i + 1}`);

/**
 * Wszystkie rdzenie objawu muszą wystąpić na początku słów opisu leku – w dowolnej kolejności.
 * `_opis_f` ma słowa rozdzielone pojedynczymi spacjami i spację na początku, a parametry mają
 * postać „ rdzeń”, więc wystarcza szybkie `contains` (bez wyrażeń regularnych liczonych per wiersz).
 */
const SYMPTOM_MATCH_SQL = `($o1 <> '' AND ${SYMPTOM_PARAMS.map((p) => `($${p} = '' OR contains(_opis_f, $${p}))`).join(" AND ")})`;

/** Podobieństwo do kandydatów `$k1…$k3`; pusty kandydat (mniej niż 3 słowa) jest pomijany – `greatest` ignoruje NULL. */
const FUZZY_SCORE_SQL = ["$k1", "$k2", "$k3"]
  .map(
    (p) => `CASE WHEN ${p} <> '' THEN greatest(
            jaro_winkler_similarity(_subst_f, ${p}),
            jaro_winkler_similarity(_subst_w1, ${p}),
            jaro_winkler_similarity(_nazwa_f, ${p}),
            jaro_winkler_similarity(_nazwa_w1, ${p})) END`,
  )
  .join(",\n          ");

/**
 * Źródło wyszukiwania: każda pozycja dostaje najlepszą (najniższą) rangę ze {@link SEARCH_RANK}
 * albo NULL, gdy w ogóle nie pasuje.
 *
 * Wyniki przybliżone (Jaro-Winkler) są wyłącznie awaryjne: podobieństwo liczone jest tylko wtedy,
 * gdy w całej bazie (we wszystkich kategoriach) nie ma żadnego trafienia dokładnego – nazwy, EAN,
 * aliasu, substancji ani objawów. Poprawnie wpisany lek nie dostaje więc „podobnych” pozycji, które
 * zaśmiecałyby listę i liczniki kategorii, a typowe zapytania nie płacą za kosztowne porównania.
 */
const RANKED_SOURCE = `(
    SELECT *, coalesce(_ranga_dokladna,
      CASE WHEN _podobienstwo >= ${FUZZY_THRESHOLD} THEN ${SEARCH_RANK.PRZYBLIZONE} END) AS _ranga
    FROM (
      SELECT *,
        CASE WHEN _dokladne_w_bazie = 0 AND $k1 <> '' THEN greatest(
          ${FUZZY_SCORE_SQL}
        ) END AS _podobienstwo
      FROM (
        SELECT *, count(_ranga_dokladna) OVER () AS _dokladne_w_bazie
        FROM (
        SELECT *,
          CASE
            WHEN kod_ean = $surowy OR _nazwa_f = $fraza OR _nazwa_f ILIKE $slowo THEN ${SEARCH_RANK.NAZWA_DOKLADNA}
            WHEN $alias_dokladny <> '' AND _subst_f ILIKE $alias_dokladny THEN ${SEARCH_RANK.ALIAS_DOKLADNY}
            WHEN _nazwa_f ILIKE $prefiks THEN ${SEARCH_RANK.NAZWA_PREFIKS}
            WHEN _nazwa_f ILIKE $wzorzec THEN ${SEARCH_RANK.NAZWA_FRAGMENT}
            WHEN _subst_f ILIKE $prefiks THEN ${SEARCH_RANK.SUBSTANCJA_PREFIKS}
            WHEN _subst_f ILIKE $wzorzec THEN ${SEARCH_RANK.SUBSTANCJA_FRAGMENT}
            WHEN $alias <> '' AND _subst_f ILIKE $alias THEN ${SEARCH_RANK.ALIAS_SUBSTANCJA}
            WHEN _wsk_f ILIKE $wzorzec OR ${SYMPTOM_MATCH_SQL} THEN ${SEARCH_RANK.OBJAWY}
          END AS _ranga_dokladna
        FROM leki
        )
      )
    )
  )`;

/** Etykieta rodzaju trafienia zwracana w polu `dopasowanie` wyniku. */
const MATCH_LABEL_SQL = `
    CASE
      WHEN _ranga IN (${SEARCH_RANK.NAZWA_DOKLADNA}, ${SEARCH_RANK.NAZWA_PREFIKS}, ${SEARCH_RANK.NAZWA_FRAGMENT}) THEN 'nazwa'
      WHEN _ranga = ${SEARCH_RANK.ALIAS_DOKLADNY} THEN 'alias'
      WHEN _ranga IN (${SEARCH_RANK.SUBSTANCJA_PREFIKS}, ${SEARCH_RANK.SUBSTANCJA_FRAGMENT}, ${SEARCH_RANK.ALIAS_SUBSTANCJA}) THEN 'substancja'
      WHEN _ranga = ${SEARCH_RANK.OBJAWY} THEN 'objawy'
      ELSE 'przyblizone'
    END`;

/**
 * Jedno zapytanie (jeden skan) dla wszystkich rodzajów trafień, posortowane wg rangi
 * (a w wynikach przybliżonych – wg podobieństwa). Liczniki kategorii i najlepsza ranga są
 * liczone funkcjami okna po wszystkich trafieniach, czyli niezależnie od filtra i limitu.
 * Pozycje spoza wybranej kategorii są sortowane na koniec i odrzucane w {@link DrugDatabase.search} –
 * dzięki temu liczniki docierają także wtedy, gdy w wybranej kategorii nie ma żadnego wyniku.
 */
const SEARCH_SQL = `
  SELECT ${HIT_COLUMNS}, ${MATCH_LABEL_SQL} AS dopasowanie,
    ${CATEGORY_FILTER} AS _w_filtrze,
    CAST(count(*) OVER () AS INTEGER) AS _n_wszystkie,
    CAST(count(*) FILTER (WHERE kategoriaDostepnosci = 'Rp') OVER () AS INTEGER) AS _n_rp,
    CAST(count(*) FILTER (WHERE kategoriaDostepnosci = 'OTC') OVER () AS INTEGER) AS _n_otc,
    CAST(min(_ranga) OVER () AS INTEGER) AS _najlepsza
  FROM ${RANKED_SOURCE}
  WHERE _ranga IS NOT NULL
  ORDER BY
    _w_filtrze DESC,
    _ranga,
    CASE WHEN _ranga = ${SEARCH_RANK.PRZYBLIZONE} THEN -round(_podobienstwo, 3) ELSE 0 END,
    nazwa, doplata_pacjenta, id
  LIMIT $limit`;

/** Wiersz {@link SEARCH_SQL}: wynik wyszukiwania i pola techniczne (usuwane przed zwróceniem). */
interface RankedRow extends SearchHit {
  _w_filtrze: boolean;
  _n_wszystkie: number;
  _n_rp: number;
  _n_otc: number;
  _najlepsza: number;
}

/** Słowa pomijane przy dopasowaniu objawów („lek na katar” → „katar”). */
const SYMPTOM_STOPWORDS: ReadonlySet<string> = new Set([
  "na",
  "od",
  "do",
  "dla",
  "przy",
  "oraz",
  "lub",
  "bez",
  "lek",
  "leki",
  "lekarstwo",
  "lekarstwa",
  "srodek",
  "srodki",
  "cos",
  "mam",
  "jak",
  "co",
]);

/**
 * Zamienia zapytanie na rdzenie słów do dopasowania w opisach „Na co pomaga”.
 * Odcina typowe polskie końcówki fleksyjne, aby „gorączka” znalazła „obniża gorączkę”
 * i „przy gorączce”, „ból gardła” – „ból i drapanie gardła”, a „katar” – „przy katarze”.
 * Słowa krótsze niż 3 znaki, liczby (dawki) i słowa pomocnicze są pomijane.
 */
export function symptomStems(query: string): string[] {
  const stems = new Set<string>();
  for (const word of foldText(query).split(/[^a-z0-9]+/)) {
    if (word.length < 3 || /\d/.test(word) || SYMPTOM_STOPWORDS.has(word)) continue;
    let stem = word;
    if (word.length >= 6) stem = word.slice(0, -2);
    else if (word.length >= 4 && /[aeiouy]$/.test(word)) stem = word.slice(0, -1);
    stems.add(stem);
    if (stems.size >= MAX_SYMPTOM_WORDS) break;
  }
  return [...stems];
}

/** Parametry `$o1…$o5` dla {@link SYMPTOM_MATCH_SQL} (puste – słowo nieużywane). */
function symptomParams(query: string): SqlParams {
  const stems = symptomStems(query);
  return Object.fromEntries(SYMPTOM_PARAMS.map((p, i) => [p, stems[i] ? ` ${stems[i]}` : ""]));
}

/** Postać opisu do wyszukiwania objawów: bez polskich znaków, słowa rozdzielone pojedynczą spacją. */
export function symptomText(value: string): string {
  return ` ${foldText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

const EQUIVALENTS_SQL = `
  SELECT ${DRUG_COLUMNS}
  FROM leki
  WHERE _grupa = (SELECT _grupa FROM leki WHERE id = $id)
  ORDER BY doplata_pacjenta, nazwa, id`;

/** Dozwolone wartości filtra kategorii w API. */
export const CATEGORY_FILTERS: readonly KategoriaFiltr[] = ["wszystkie", "Rp", "OTC"];

/** Usuwa znaki wieloznaczne LIKE i nadmiarowe spacje z frazy użytkownika. */
export function sanitizeSearchTerm(raw: string): string {
  return raw
    .replace(/[%_\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface PooledConnection {
  conn: DuckDBConnection;
  statements: Map<string, DuckDBPreparedStatement>;
}

type SqlParams = Record<string, string | number | null>;

/** True, gdy zapytanie zawiera parametr nazwany `$name` (z granicą słowa). */
function sqlUsesParam(sql: string, name: string): boolean {
  return new RegExp(`\\$${name}\\b`).test(sql);
}

export interface OpenOptions extends EnsureDataOptions {
  /** Liczba połączeń w puli (zapytania równoległe). */
  poolSize?: number;
}

export class DrugDatabase {
  private readonly idle: PooledConnection[];
  private readonly waiters: ((c: PooledConnection) => void)[] = [];
  private closed = false;

  private constructor(
    private readonly instance: DuckDBInstance,
    connections: PooledConnection[],
    readonly meta: DataMeta,
    readonly rowCount: number,
  ) {
    this.idle = connections;
  }

  /**
   * Otwiera bazę: zapewnia istnienie pliku Parquet, tworzy instancję DuckDB w pamięci,
   * jednorazowo definiuje widok `leki_zrodlo` nad plikiem Parquet i materializuje
   * tabelę `leki` z wyliczonymi z góry kolumnami pomocniczymi (patrz {@link MATERIALIZE_SQL}).
   */
  static async open(options: OpenOptions): Promise<DrugDatabase> {
    const meta = await ensureDataFile(options);
    const instance = await DuckDBInstance.create(":memory:");
    const setup = await instance.connect();
    await setup.run("SET parquet_metadata_cache = true");
    // Plik z v1.1.0 (bez kolumn kategorii i ATC) jest nadal obsługiwany – brakujące kolumny mają wartości domyślne.
    await setup.run(`
      CREATE OR REPLACE VIEW leki_zrodlo AS
      SELECT ${await parquetSelectList(setup, options.dataFilePath)}
      FROM read_parquet(${toSqlPath(options.dataFilePath)})`);
    await setup.run(MATERIALIZE_SQL);
    await materializeDescriptions(setup);
    const countReader = await setup.runAndReadAll(
      `SELECT CAST(count(*) AS INTEGER) AS n,
              CAST(count(*) FILTER (WHERE kategoriaDostepnosci = 'Rp') AS INTEGER) AS rp,
              CAST(count(*) FILTER (WHERE kategoriaDostepnosci = 'OTC') AS INTEGER) AS otc
       FROM leki`,
    );
    const counts = countReader.getRowObjectsJson()[0] as { n: number; rp: number; otc: number };
    const rowCount = Number(counts.n);

    const poolSize = Math.max(1, options.poolSize ?? 4);
    const pool: PooledConnection[] = [{ conn: setup, statements: new Map() }];
    for (let i = 1; i < poolSize; i++) {
      pool.push({ conn: await instance.connect(), statements: new Map() });
    }
    const fullMeta: DataMeta = { ...meta, rows: rowCount, rows_rp: Number(counts.rp), rows_otc: Number(counts.otc) };
    return new DrugDatabase(instance, pool, fullMeta, rowCount);
  }

  get source(): DataSource {
    return this.meta.source;
  }

  private acquire(): Promise<PooledConnection> {
    if (this.closed) return Promise.reject(new Error("Baza danych została zamknięta."));
    const conn = this.idle.pop();
    if (conn) return Promise.resolve(conn);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(conn: PooledConnection): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(conn);
    else this.idle.push(conn);
  }

  /** Wykonuje sparametryzowane zapytanie z cache'owaniem przygotowanych instrukcji per połączenie. */
  private async query<T>(sql: string, params: SqlParams): Promise<Timed<T[]>> {
    const pooled = await this.acquire();
    try {
      let statement = pooled.statements.get(sql);
      if (!statement) {
        statement = await pooled.conn.prepare(sql);
        pooled.statements.set(sql, statement);
      }
      // DuckDB odrzuca nadmiarowe parametry – wiążemy tylko te, które występują w zapytaniu
      // (etapy wyszukiwania współdzielą zestaw parametrów między zapytaniem o dane i o liczniki).
      statement.bind(Object.fromEntries(Object.entries(params).filter(([k]) => sqlUsesParam(sql, k))));
      const started = performance.now();
      const reader = await statement.runAndReadAll();
      const rows = reader.getRowObjectsJson() as unknown as T[];
      return { data: rows, durationMs: performance.now() - started };
    } finally {
      this.release(pooled);
    }
  }

  /**
   * Wyszukuje leki po nazwie handlowej, aliasie, substancji czynnej, objawie lub kodzie EAN.
   *
   * Wszystkie rodzaje trafień trafiają do jednego rankingu ({@link SEARCH_RANK}):
   *  1. dokładne dopasowanie nazwy leku, EAN lub całego aliasu ze słownika ({@link resolveAlias}),
   *     np. „apap” → Paracetamolum; dalej prefiks i fragment nazwy,
   *  2. substancja czynna (także rozpoznana z polskiej nazwy), opis „Na co pomaga” i wskazanie
   *     refundacyjne – dzięki temu „katar”, „zgaga” czy „ból gardła” zwracają pasujące leki,
   *  3. dopasowania przybliżone `jaro_winkler_similarity(...) >= 0.82` (literówki) – wyłącznie
   *     wtedy, gdy zapytanie nie dało żadnego z powyższych trafień (`matchMode: "fuzzy"`).
   *
   * `kategoria` zawęża wyniki do leków refundowanych („Rp”) lub bez recepty („OTC”); liczniki
   * `liczniki` zawsze obejmują wszystkie kategorie – dzięki temu przełącznik filtrów w interfejsie
   * pokazuje, ile pozycji czeka w każdej kategorii. `matchMode` opisuje najlepsze trafienie.
   */
  async search(rawQuery: string, limit: number, kategoria: KategoriaFiltr = "wszystkie"): Promise<Timed<SearchResult>> {
    const term = sanitizeSearchTerm(rawQuery);
    const folded = foldText(term);
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const filter: KategoriaFiltr = CATEGORY_FILTERS.includes(kategoria) ? kategoria : "wszystkie";
    const empty: CategoryCounts = { wszystkie: 0, Rp: 0, OTC: 0 };
    if (folded.length === 0) {
      return { data: { query: term, count: 0, items: [], kategoria: filter, liczniki: empty }, durationMs: 0 };
    }
    // Zapytanie, które już zawiera rdzeń substancji („atorvastatinum”, „paracetamol”), obsługują
    // rangi nazwy i substancji – alias dotyczy marek i polskich nazw („apap”, „atorwastatyna”).
    const resolved = resolveAlias(term);
    const aliasStem = resolved ? foldText(substanceStem(resolved.substance)) : "";
    const alias = resolved && !folded.includes(aliasStem) ? resolved : null;
    const aliasPattern = alias ? `%${aliasStem}%` : "";
    const aliasIsWhole = alias?.kind === "brand" && aliasKey(alias.matched) === aliasKey(term);
    const [k1 = "", k2 = "", k3 = ""] = fuzzyCandidates(term);
    const params: SqlParams = {
      surowy: term,
      fraza: folded,
      slowo: `${folded} %`,
      prefiks: `${folded}%`,
      wzorzec: `%${folded}%`,
      alias_dokladny: aliasIsWhole ? aliasPattern : "",
      alias: aliasPattern,
      ...symptomParams(term),
      k1,
      k2,
      k3,
    };

    const { data: rows, durationMs } = await this.query<RankedRow>(SEARCH_SQL, {
      ...params,
      kategoria: filter,
      limit: safeLimit,
    });
    const first = rows[0];
    if (!first) {
      return {
        data: { query: term, count: 0, items: [], matchMode: "direct", kategoria: filter, liczniki: empty },
        durationMs,
      };
    }
    const liczniki: CategoryCounts = {
      wszystkie: Number(first._n_wszystkie),
      Rp: Number(first._n_rp),
      OTC: Number(first._n_otc),
    };
    const items: SearchHit[] = rows
      .filter((r) => r._w_filtrze)
      .map(({ _w_filtrze, _n_wszystkie, _n_rp, _n_otc, _najlepsza, ...hit }) => hit);
    const base = { query: term, count: items.length, items, kategoria: filter, liczniki };
    const best = Number(first._najlepsza);

    if (best === SEARCH_RANK.PRZYBLIZONE) {
      return {
        data: { ...base, matchMode: "fuzzy", resolvedNote: `Pokazuję najbardziej zbliżone wyniki dla: ${term}` },
        durationMs,
      };
    }
    if (alias && (best === SEARCH_RANK.ALIAS_DOKLADNY || best === SEARCH_RANK.ALIAS_SUBSTANCJA)) {
      return {
        data: {
          ...base,
          matchMode: "alias",
          resolvedSubstance: alias.substance,
          resolvedNote: `Rozpoznano substancję: ${alias.substance} (dla zapytania: ${alias.matched})`,
        },
        durationMs,
      };
    }
    if (best === SEARCH_RANK.OBJAWY) {
      return {
        data: { ...base, matchMode: "direct", resolvedNote: `Pokazuję leki, które pomagają na: ${term}` },
        durationMs,
      };
    }
    return { data: { ...base, matchMode: "direct" }, durationMs };
  }

  /** Zwraca grupę zamienników wybranego leku z wyliczeniem oszczędności (null, gdy brak leku). */
  async equivalents(id: number): Promise<Timed<EquivalentsResult | null>> {
    const { data, durationMs } = await this.query<DrugRecord>(EQUIVALENTS_SQL, { id });
    const selected = data.find((d) => d.id === id);
    if (!selected) return { data: null, durationMs };
    return { data: buildEquivalents(selected, data), durationMs };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pooled of this.idle) {
      for (const statement of pooled.statements.values()) statement.destroySync();
      pooled.conn.closeSync();
    }
    this.idle.length = 0;
    this.instance.closeSync();
  }
}
