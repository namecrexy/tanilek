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
import { describeDrug, fuzzyCandidates, resolveAlias, substanceStem } from "./aliases";
import type {
  DataMeta,
  DataSource,
  DrugRecord,
  EquivalentsResult,
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
  return {
    wybrany: selected,
    wskazanie: selected.wskazanie ?? "",
    opisSubstancji: describeDrug(selected),
    zamienniki,
    najlepsza_oferta: best,
  };
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

export interface ColumnMapping {
  /** Nazwa kolumny źródłowej dla każdej kolumny kanonicznej. */
  columns: Partial<Record<CanonicalColumn, string>>;
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
const HEADER_RULES: ReadonlyArray<[CanonicalColumn, HeaderRule]> = [
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
];

/** Dopasowuje nagłówki źródła do kolumn kanonicznych. Każda kolumna źródłowa użyta jest co najwyżej raz. */
export function mapSourceColumns(headers: readonly string[]): ColumnMapping {
  const columns: Partial<Record<CanonicalColumn, string>> = {};
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
  const col = (c: CanonicalColumn) => {
    const header = mapping.columns[c];
    return header === undefined ? null : `CAST(${quoteIdent(header)} AS VARCHAR)`;
  };
  const text = (c: CanonicalColumn) => {
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
      wskazanie
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

/** Buduje plik Parquet z dołączonej próbki CSV (tryb demo / awaryjny). */
export function buildFromFallback(fallbackCsvPath: string, parquetPath: string): Promise<DataMeta> {
  return buildParquet({
    inputPath: fallbackCsvPath,
    kind: "csv",
    parquetPath,
    meta: { source: "fallback-demo", resource_url: null, resource_title: "Próbka demonstracyjna (35 leków)" },
  });
}

const REQUIRED_PARQUET_COLUMNS = ["id", ...CANONICAL_COLUMNS, "liczba_jednostek"];

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
  "poziom_odplatnosci, doplata_pacjenta, cena_detaliczna, wskazanie";

/** Klucz grupy zamienników: ta sama substancja czynna, dawka i postać. */
const GROUP_KEY_SQL = `
  ${foldSql("substancja_czynna")} || '|' ||
  replace(replace(lower(coalesce(dawka, '')), ' ', ''), ',', '.') || '|' ||
  regexp_replace(${foldSql("postac")}, '\\s+', ' ', 'g')`;

/**
 * Jednorazowa materializacja przy starcie: widok `leki_zrodlo` (nad plikiem Parquet) jest
 * kopiowany do kolumnowej tabeli w pamięci razem z wyliczonymi z góry kolumnami pomocniczymi:
 * tekstem do wyszukiwania, kluczem grupy zamienników i statystyką oszczędności dla każdej pozycji.
 * Dzięki temu zapytanie użytkownika to pojedynczy, filtrowany skan bez złączeń.
 */
const MATERIALIZE_SQL = `
  CREATE OR REPLACE TABLE leki AS
  WITH baza AS (
    SELECT ${DRUG_COLUMNS},
      ${foldSql("nazwa")} AS _nazwa_f,
      ${foldSql("substancja_czynna")} AS _subst_f,
      ${foldSql("wskazanie")} AS _wsk_f,
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
        END)), 2) AS mozliwa_oszczednosc
    FROM baza t
    JOIN baza o ON o._grupa = t._grupa
    GROUP BY t.id
  )
  SELECT b.*, p.liczba_zamiennikow, p.najnizsza_doplata_w_grupie, p.mozliwa_oszczednosc
  FROM baza b
  JOIN porownanie p USING (id)
  ORDER BY b.id`;

const SEARCH_SQL = `
  SELECT ${DRUG_COLUMNS}, liczba_zamiennikow, najnizsza_doplata_w_grupie, mozliwa_oszczednosc
  FROM leki
  WHERE _nazwa_f ILIKE $wzorzec
     OR _subst_f ILIKE $wzorzec
     OR _wsk_f ILIKE $wzorzec
     OR kod_ean = $surowy
  ORDER BY
    CASE
      WHEN kod_ean = $surowy THEN 0
      WHEN _nazwa_f ILIKE $prefiks THEN 0
      WHEN _subst_f ILIKE $prefiks THEN 1
      WHEN _nazwa_f ILIKE $wzorzec THEN 2
      WHEN _subst_f ILIKE $wzorzec THEN 3
      ELSE 4
    END,
    nazwa, doplata_pacjenta, id
  LIMIT $limit`;

/** Etap 2: wyszukiwanie po rdzeniu łacińskiej substancji rozpoznanej ze słownika aliasów. */
const ALIAS_SEARCH_SQL = `
  SELECT ${DRUG_COLUMNS}, liczba_zamiennikow, najnizsza_doplata_w_grupie, mozliwa_oszczednosc
  FROM leki
  WHERE _subst_f ILIKE $wzorzec
  ORDER BY
    CASE WHEN _subst_f ILIKE $prefiks THEN 0 ELSE 1 END,
    nazwa, doplata_pacjenta, id
  LIMIT $limit`;

/** Minimalne podobieństwo Jaro-Winklera dla wyników przybliżonych. */
export const FUZZY_THRESHOLD = 0.82;

const FUZZY_SCORE_SQL = ["$k1", "$k2", "$k3"]
  .flatMap((p) => [
    `jaro_winkler_similarity(_subst_f, ${p})`,
    `jaro_winkler_similarity(split_part(_subst_f, ' ', 1), ${p})`,
    `jaro_winkler_similarity(_nazwa_f, ${p})`,
    `jaro_winkler_similarity(split_part(_nazwa_f, ' ', 1), ${p})`,
  ])
  .join(",\n      ");

/** Etap 3: wyszukiwanie przybliżone (literówki) – wbudowana funkcja DuckDB `jaro_winkler_similarity`. */
const FUZZY_SEARCH_SQL = `
  SELECT ${DRUG_COLUMNS}, liczba_zamiennikow, najnizsza_doplata_w_grupie, mozliwa_oszczednosc
  FROM (
    SELECT *, greatest(
      ${FUZZY_SCORE_SQL}
    ) AS _podobienstwo
    FROM leki
  )
  WHERE _podobienstwo >= ${FUZZY_THRESHOLD}
  ORDER BY round(_podobienstwo, 3) DESC, nazwa, doplata_pacjenta, id
  LIMIT $limit`;

const EQUIVALENTS_SQL = `
  SELECT ${DRUG_COLUMNS}
  FROM leki
  WHERE _grupa = (SELECT _grupa FROM leki WHERE id = $id)
  ORDER BY doplata_pacjenta, nazwa, id`;

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
    await setup.run(`
      CREATE OR REPLACE VIEW leki_zrodlo AS
      SELECT ${DRUG_COLUMNS}
      FROM read_parquet(${toSqlPath(options.dataFilePath)})`);
    await setup.run(MATERIALIZE_SQL);
    const countReader = await setup.runAndReadAll("SELECT CAST(count(*) AS INTEGER) AS n FROM leki");
    const rowCount = Number((countReader.getRowObjectsJson()[0] as { n: number }).n);

    const poolSize = Math.max(1, options.poolSize ?? 4);
    const pool: PooledConnection[] = [{ conn: setup, statements: new Map() }];
    for (let i = 1; i < poolSize; i++) {
      pool.push({ conn: await instance.connect(), statements: new Map() });
    }
    return new DrugDatabase(instance, pool, { ...meta, rows: rowCount }, rowCount);
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
      statement.bind(params);
      const started = performance.now();
      const reader = await statement.runAndReadAll();
      const rows = reader.getRowObjectsJson() as unknown as T[];
      return { data: rows, durationMs: performance.now() - started };
    } finally {
      this.release(pooled);
    }
  }

  /**
   * Wyszukuje leki po nazwie handlowej, substancji czynnej, wskazaniu lub kodzie EAN.
   *
   * Trzy etapy (kolejny uruchamiany tylko, gdy poprzedni nie dał wyników):
   *  1. bezpośrednie dopasowanie ILIKE (nazwa, substancja, wskazanie, EAN),
   *  2. słownik marek i polskich nazw substancji ({@link resolveAlias}), np. „apap” → Paracetamolum,
   *  3. dopasowanie przybliżone `jaro_winkler_similarity(...) >= 0.82` dla literówek.
   */
  async search(rawQuery: string, limit: number): Promise<Timed<SearchResult>> {
    const term = sanitizeSearchTerm(rawQuery);
    const folded = foldText(term);
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    if (folded.length === 0) {
      return { data: { query: term, count: 0, items: [] }, durationMs: 0 };
    }
    const direct = await this.query<SearchHit>(SEARCH_SQL, {
      wzorzec: `%${folded}%`,
      prefiks: `${folded}%`,
      surowy: term,
      limit: safeLimit,
    });
    let durationMs = direct.durationMs;
    if (direct.data.length > 0) {
      return { data: { query: term, count: direct.data.length, items: direct.data, matchMode: "direct" }, durationMs };
    }

    const alias = resolveAlias(term);
    if (alias) {
      const stem = foldText(substanceStem(alias.substance));
      const viaAlias = await this.query<SearchHit>(ALIAS_SEARCH_SQL, {
        wzorzec: `%${stem}%`,
        prefiks: `${stem}%`,
        limit: safeLimit,
      });
      durationMs += viaAlias.durationMs;
      if (viaAlias.data.length > 0) {
        const items = viaAlias.data;
        return {
          data: {
            query: term,
            count: items.length,
            items,
            matchMode: "alias",
            resolvedSubstance: alias.substance,
            resolvedNote: `Rozpoznano substancję: ${alias.substance} (dla zapytania: ${alias.matched})`,
          },
          durationMs,
        };
      }
    }

    const candidates = fuzzyCandidates(term);
    if (candidates.length > 0) {
      const [k1, k2 = k1, k3 = k2] = candidates;
      const fuzzy = await this.query<SearchHit>(FUZZY_SEARCH_SQL, {
        k1: k1 ?? "",
        k2: k2 ?? "",
        k3: k3 ?? "",
        limit: safeLimit,
      });
      durationMs += fuzzy.durationMs;
      if (fuzzy.data.length > 0) {
        return {
          data: {
            query: term,
            count: fuzzy.data.length,
            items: fuzzy.data,
            matchMode: "fuzzy",
            resolvedNote: `Pokazuję najbardziej zbliżone wyniki dla: ${term}`,
          },
          durationMs,
        };
      }
    }
    return { data: { query: term, count: 0, items: [], matchMode: "direct" }, durationMs };
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
