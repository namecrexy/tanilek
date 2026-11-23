import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  decodeText,
  findWykazXlsx,
  isRefundValueTitle,
  parseObwieszczeniaList,
  pickResources,
  scoreDatasetTitle,
} from "../scripts/fetch_data";
import {
  buildEquivalents,
  buildFromFallback,
  buildParquet,
  calculateSavings,
  convertXlsxToCsv,
  DrugDatabase,
  ensureDataFile,
  foldText,
  isValidParquet,
  listXlsxSheets,
  mapSourceColumns,
  metaPathFor,
  missingRequired,
  SourceFormatError,
  sanitizeSearchTerm,
  toSqlPath,
} from "../src/db";
import { BUILTIN_OTC } from "../src/otc";
import type { DrugRecord } from "../src/types";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");

function drug(overrides: Partial<DrugRecord>): DrugRecord {
  return {
    id: 1,
    nazwa: "Lek",
    substancja_czynna: "Substancja",
    dawka: "10 mg",
    postac: "tabl.",
    opakowanie: "30 szt.",
    liczba_jednostek: 30,
    kod_ean: "5900000000000",
    poziom_odplatnosci: "30%",
    doplata_pacjenta: 10,
    cena_detaliczna: 20,
    wskazanie: "",
    kategoriaDostepnosci: "Rp",
    czyRefundowany: true,
    kodAtc: null,
    ...overrides,
  };
}

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tanilek-db-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe("calculateSavings", () => {
  test("wylicza oszczędność w PLN i % dla tego samego opakowania", () => {
    const sortis = drug({ id: 1, nazwa: "Sortis", doplata_pacjenta: 85 });
    const atoris = drug({ id: 2, nazwa: "Atoris", doplata_pacjenta: 3.2 });
    const quote = calculateSavings(sortis, atoris);
    expect(quote.oszczednosc_pln).toBe(81.8);
    expect(quote.oszczednosc_proc).toBe(96.2);
    expect(quote.doplata_porownawcza).toBe(3.2);
    expect(quote.przeliczono_na_opakowanie).toBe(false);
    expect(quote.jest_wybranym).toBe(false);
  });

  test("przelicza dopłatę na wielkość opakowania wybranego leku", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 9.95, liczba_jednostek: 30 });
    const bigPack = drug({ id: 2, doplata_pacjenta: 4.2, liczba_jednostek: 60 });
    const quote = calculateSavings(selected, bigPack);
    expect(quote.przeliczono_na_opakowanie).toBe(true);
    expect(quote.doplata_porownawcza).toBe(2.1);
    expect(quote.oszczednosc_pln).toBe(7.85);
  });

  test("nie przelicza, gdy liczba jednostek jest nieznana", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 10, liczba_jednostek: null });
    const alt = drug({ id: 2, doplata_pacjenta: 4, liczba_jednostek: 60 });
    const quote = calculateSavings(selected, alt);
    expect(quote.przeliczono_na_opakowanie).toBe(false);
    expect(quote.oszczednosc_pln).toBe(6);
  });

  test("droższy zamiennik daje ujemną oszczędność", () => {
    const quote = calculateSavings(drug({ id: 1, doplata_pacjenta: 2 }), drug({ id: 2, doplata_pacjenta: 5 }));
    expect(quote.oszczednosc_pln).toBe(-3);
    expect(quote.oszczednosc_proc).toBe(-150);
  });

  test("dopłata 0 zł nie powoduje dzielenia przez zero", () => {
    const quote = calculateSavings(drug({ id: 1, doplata_pacjenta: 0 }), drug({ id: 2, doplata_pacjenta: 0 }));
    expect(quote.oszczednosc_pln).toBe(0);
    expect(quote.oszczednosc_proc).toBe(0);
  });

  test("liczy w groszach – brak błędów zmiennoprzecinkowych", () => {
    const quote = calculateSavings(drug({ id: 1, doplata_pacjenta: 0.3 }), drug({ id: 2, doplata_pacjenta: 0.1 }));
    expect(quote.oszczednosc_pln).toBe(0.2);
  });

  test("oznacza porównanie leku z samym sobą", () => {
    const d = drug({ id: 7 });
    const quote = calculateSavings(d, d);
    expect(quote.jest_wybranym).toBe(true);
    expect(quote.oszczednosc_pln).toBe(0);
  });
});

describe("buildEquivalents", () => {
  test("sortuje od najtańszego i wskazuje najlepszą ofertę", () => {
    const selected = drug({ id: 1, nazwa: "Drogi", doplata_pacjenta: 50 });
    const group = [
      selected,
      drug({ id: 2, nazwa: "Średni", doplata_pacjenta: 10 }),
      drug({ id: 3, nazwa: "Tani", doplata_pacjenta: 2 }),
    ];
    const result = buildEquivalents(selected, group);
    expect(result.zamienniki.map((q) => q.lek.nazwa)).toEqual(["Tani", "Średni", "Drogi"]);
    expect(result.najlepsza_oferta?.lek.nazwa).toBe("Tani");
    expect(result.najlepsza_oferta?.oszczednosc_pln).toBe(48);
  });

  test("brak najlepszej oferty, gdy wybrany lek jest najtańszy", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 1 });
    const result = buildEquivalents(selected, [selected, drug({ id: 2, doplata_pacjenta: 3 })]);
    expect(result.najlepsza_oferta).toBeNull();
    expect(result.zamienniki[0]?.jest_wybranym).toBe(true);
  });

  test("przy równej cenie wybrany lek jest pierwszy i nie jest „ofertą”", () => {
    const selected = drug({ id: 5, nazwa: "B", doplata_pacjenta: 3.2 });
    const result = buildEquivalents(selected, [drug({ id: 4, nazwa: "A", doplata_pacjenta: 3.2 }), selected]);
    expect(result.zamienniki[0]?.jest_wybranym).toBe(true);
    expect(result.najlepsza_oferta).toBeNull();
  });

  test("dodaje wybrany lek, jeśli nie ma go w grupie", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 5 });
    const result = buildEquivalents(selected, [drug({ id: 2, doplata_pacjenta: 4 })]);
    expect(result.zamienniki).toHaveLength(2);
  });
});

describe("funkcje pomocnicze tekstu", () => {
  test("foldText usuwa polskie znaki i wielkość liter", () => {
    expect(foldText("Nadciśnienie TĘTNICZE")).toBe("nadcisnienie tetnicze");
    expect(foldText("ŁÓDŹ żółć")).toBe("lodz zolc");
  });

  test("sanitizeSearchTerm usuwa znaki wieloznaczne LIKE", () => {
    expect(sanitizeSearchTerm("  %_ator\\va  ")).toBe("ator va");
    expect(sanitizeSearchTerm("%%%")).toBe("");
  });

  test("toSqlPath zamienia ukośniki i escapuje apostrofy", () => {
    expect(toSqlPath("C:\\dane\\o'reilly.parquet")).toBe("'C:/dane/o''reilly.parquet'");
  });
});

describe("mapSourceColumns", () => {
  test("rozpoznaje nagłówki kanoniczne", () => {
    const mapping = mapSourceColumns([
      "id",
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
    ]);
    expect(mapping.combinedName).toBe(false);
    expect(missingRequired(mapping)).toEqual([]);
    expect(mapping.columns.kod_ean).toBe("kod_ean");
    expect(mapping.columns.cena_detaliczna).toBe("cena_detaliczna");
  });

  test("rozpoznaje nagłówki obwieszczenia Ministra Zdrowia", () => {
    const mapping = mapSourceColumns([
      "Lp.",
      "Substancja czynna",
      "Nazwa  postać i dawka leku",
      "Zawartość opakowania",
      "Identyfikator Leku [kod EAN lub inny kod odpowiadający kodowi EAN]",
      "Urzędowa cena zbytu",
      "Cena detaliczna",
      "Wysokość limitu finansowania",
      "Zakres wskazań objętych refundacją",
      "Zakres wskazań pozarejestracyjnych objętych refundacją",
      "Poziom odpłatności",
      "Wysokość dopłaty świadczeniobiorcy",
    ]);
    expect(mapping.combinedName).toBe(true);
    expect(mapping.columns.nazwa).toBe("Nazwa  postać i dawka leku");
    expect(mapping.columns.opakowanie).toBe("Zawartość opakowania");
    expect(mapping.columns.kod_ean).toStartWith("Identyfikator Leku");
    expect(mapping.columns.wskazanie).toBe("Zakres wskazań objętych refundacją");
    expect(mapping.columns.doplata_pacjenta).toBe("Wysokość dopłaty świadczeniobiorcy");
    expect(mapping.columns.cena_detaliczna).toBe("Cena detaliczna");
  });

  test("zgłasza brak wymaganych kolumn", () => {
    expect(missingRequired(mapSourceColumns(["foo", "bar"]))).toEqual([
      "nazwa",
      "substancja_czynna",
      "doplata_pacjenta",
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe("budowa pliku Parquet", () => {
  test("buduje Parquet (ZSTD) z próbki i zapisuje metadane", async () => {
    const parquet = join(workDir, "probka.parquet");
    const meta = await buildFromFallback(FIXTURE, parquet);
    expect(meta.rows).toBe(35 + BUILTIN_OTC.length);
    expect(meta.rows_rp).toBe(35);
    expect(meta.source).toBe("fallback-demo");
    expect(existsSync(parquet)).toBe(true);
    expect(await isValidParquet(parquet)).toBe(true);

    const saved = JSON.parse(await readFile(metaPathFor(parquet), "utf8"));
    expect(saved.rows).toBe(35 + BUILTIN_OTC.length);

    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const reader = await conn.runAndReadAll(`SELECT DISTINCT compression FROM parquet_metadata(${toSqlPath(parquet)})`);
    const codecs = (reader.getRowObjectsJson() as { compression: string }[]).map((r) => r.compression);
    conn.closeSync();
    instance.closeSync();
    expect(codecs).toEqual(["ZSTD"]);
  });

  test("normalizuje plik w formacie obwieszczenia MZ (tytuł nad tabelą, polskie kwoty)", async () => {
    const csv = [
      "Obwieszczenie Ministra Zdrowia – wykaz A1;;;;;;",
      // Nagłówki jak w załączniku XLSX obwieszczenia z 2026 r. (kolumna „Numer GTIN…”).
      "LP;Substancja czynna;Nazwa  postać i dawka;Zawartość opakowania;Numer GTIN lub inny kod jednoznacznie identyfikujący produkt;Cena detaliczna;Poziom odpłatności;Wysokość dopłaty świadczeniobiorcy;Zakres wskazań objętych refundacją",
      '1;Atorvastatinum;"Atoris, tabl. powl., 20 mg";30 szt.;05909990000014;14,10 zł;30%;3,20 zł;Hipercholesterolemia',
      ";;;;;;;;",
      '2;Atorvastatinum;"Sortis, tabl. powl., 20 mg";30 tabl.;5909990000021;92,40;30%;85,00;Hipercholesterolemia',
      ";;;;;;;;",
    ].join("\n");
    const input = join(workDir, "mz.csv");
    await writeFile(input, csv, "utf8");
    const parquet = join(workDir, "mz.parquet");
    const meta = await buildParquet({
      inputPath: input,
      kind: "csv",
      parquetPath: parquet,
      meta: { source: "parquet", resource_url: "https://example.test/mz.csv", resource_title: "Test MZ" },
    });
    expect(meta.rows).toBe(2);

    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const reader = await conn.runAndReadAll(`SELECT * FROM read_parquet(${toSqlPath(parquet)}) ORDER BY id`);
    const rows = reader.getRowObjectsJson() as unknown as DrugRecord[];
    conn.closeSync();
    instance.closeSync();

    expect(rows[0]).toMatchObject({
      id: 1,
      nazwa: "Atoris",
      postac: "tabl. powl.",
      dawka: "20 mg",
      opakowanie: "30 szt.",
      liczba_jednostek: 30,
      kod_ean: "5909990000014",
      doplata_pacjenta: 3.2,
      cena_detaliczna: 14.1,
      wskazanie: "Hipercholesterolemia",
    });
    expect(rows[1]).toMatchObject({ nazwa: "Sortis", doplata_pacjenta: 85, liczba_jednostek: 30 });
  });

  test("rozbija „Nazwa postać i dawka” jak w obwieszczeniu z 16.09.2026 (przecinki dziesiętne, kilka dawek, brak dawki)", async () => {
    const header =
      "LP,Substancja czynna,Nazwa  postać i dawka,Zawartość opakowania,Numer GTIN lub inny kod jednoznacznie identyfikujący produkt,Cena detaliczna,Zakres wskazań objętych refundacją,Zakres wskazań pozarejestracyjnych objętych refundacją,Poziom odpłatności,Wysokość dopłaty świadczeniobiorcy";
    const csv = [
      "A 1. Leki refundowane dostępne w aptece na receptę",
      header,
      '1,Levonorgestrelum + Ethinylestradiolum,"Rigevidon, tabl. powl., 0,03+0,15 mg",21 szt.,05909990000111,"10,00",Antykoncepcja,,30%,"3,00"',
      '2,Aprepitantum,"Aprepitant Stada, kaps. twarde, 125 mg, 80 mg",3 szt.,05909990000128,"120,00",Wymioty,,ryczałt,"5,00"',
      '3,Calcipotriolum + Betamethasonum,"Daivobet, żel, (50 µg+0,5 mg)/g",60 g,05909990000135,"80,00",Łuszczyca,,30%,"24,00"',
      '4,Midazolamum,"Relsed, mikrowlewka doodbytnicza, roztwór, 4 mg/ml",5 szt.,05909990000142,"40,00",Drgawki,,ryczałt,"3,20"',
      '5,Vaccinum,"Arexvy, proszek i zawiesina do sporządzania zawiesiny do wstrzykiwań",1 fiol.,05909990000159,"200,00",Szczepienia,,50%,"100,00"',
      '6,Salbutamolum,"Ventolin, aerozol inhalacyjny, zawiesina, 100 µg/dawkę inhalacyjną",1 inh.po 200 daw.,05909990000166,"15,00","Astma,\nPOChP",,ryczałt,"4,00"',
    ].join("\n");
    const input = join(workDir, "mz-2026.csv");
    await writeFile(input, csv, "utf8");
    const parquet = join(workDir, "mz-2026.parquet");
    const meta = await buildParquet({
      inputPath: input,
      kind: "csv",
      parquetPath: parquet,
      meta: { source: "parquet", resource_url: null, resource_title: "Test MZ 2026" },
    });
    expect(meta.rows).toBe(6);

    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const reader = await conn.runAndReadAll(
      `SELECT nazwa, postac, dawka, liczba_jednostek, wskazanie FROM read_parquet(${toSqlPath(parquet)}) ORDER BY id`,
    );
    const rows = reader.getRowObjectsJson();
    conn.closeSync();
    instance.closeSync();

    expect(rows.map((r) => [r.nazwa, r.postac, r.dawka])).toEqual([
      ["Rigevidon", "tabl. powl.", "0,03+0,15 mg"],
      ["Aprepitant Stada", "kaps. twarde", "125 mg, 80 mg"],
      ["Daivobet", "żel", "(50 µg+0,5 mg)/g"],
      ["Relsed", "mikrowlewka doodbytnicza, roztwór", "4 mg/ml"],
      ["Arexvy", "proszek i zawiesina do sporządzania zawiesiny do wstrzykiwań", ""],
      ["Ventolin", "aerozol inhalacyjny, zawiesina", "100 µg/dawkę inhalacyjną"],
    ]);
    // Inhalator liczony w dawkach; komórka z nową linią wczytana w całości.
    expect(rows[5]).toMatchObject({ liczba_jednostek: 200, wskazanie: "Astma, POChP" });
  });

  test("odrzuca plik o nieznanej strukturze", async () => {
    const input = join(workDir, "zly.csv");
    await writeFile(input, "a;b;c\n1;2;3\n", "utf8");
    const promise = buildParquet({
      inputPath: input,
      kind: "csv",
      parquetPath: join(workDir, "zly.parquet"),
      meta: { source: "parquet", resource_url: null, resource_title: null },
    });
    await expect(promise).rejects.toBeInstanceOf(SourceFormatError);
    expect(existsSync(join(workDir, "zly.parquet"))).toBe(false);
  });

  test("odrzuca źródło z liczbą wierszy poniżej minimum", async () => {
    const promise = buildParquet({
      inputPath: FIXTURE,
      kind: "csv",
      parquetPath: join(workDir, "malo.parquet"),
      minRows: 1000,
      meta: { source: "parquet", resource_url: null, resource_title: null },
    });
    await expect(promise).rejects.toThrow(/minimum/);
  });

  test("ensureDataFile odbudowuje uszkodzony plik z próbki", async () => {
    const parquet = join(workDir, "uszkodzony.parquet");
    await writeFile(parquet, "to nie jest parquet");
    expect(await isValidParquet(parquet)).toBe(false);
    const messages: string[] = [];
    const meta = await ensureDataFile({
      dataFilePath: parquet,
      fallbackCsvPath: FIXTURE,
      log: (m) => messages.push(m),
    });
    expect(meta.source).toBe("fallback-demo");
    expect(meta.rows).toBe(35 + BUILTIN_OTC.length);
    expect(meta.rows_rp).toBe(35);
    expect(messages.length).toBe(1);
    expect(await isValidParquet(parquet)).toBe(true);
  });

  test("ensureDataFile nie przebudowuje poprawnego pliku", async () => {
    const parquet = join(workDir, "probka.parquet");
    const before = (await readFile(metaPathFor(parquet), "utf8")).toString();
    const meta = await ensureDataFile({ dataFilePath: parquet, fallbackCsvPath: FIXTURE });
    expect(meta.built_at).toBe(JSON.parse(before).built_at);
  });
});

/* -------------------------------------------------------------------------- */

describe("DrugDatabase – zapytania DuckDB", () => {
  let db: DrugDatabase;

  beforeAll(async () => {
    db = await DrugDatabase.open({
      dataFilePath: join(workDir, "baza.parquet"),
      fallbackCsvPath: FIXTURE,
      poolSize: 2,
    });
  });

  afterAll(() => db.close());

  test("wczytuje 35 leków Rp z próbki i wbudowane leki OTC w trybie demo", () => {
    expect(db.rowCount).toBe(35 + BUILTIN_OTC.length);
    expect(db.meta.rows_rp).toBe(35);
    expect(db.meta.rows_otc).toBe(BUILTIN_OTC.length);
    expect(db.source).toBe("fallback-demo");
  });

  test("wyszukuje po nazwie handlowej bez względu na wielkość liter", async () => {
    const { data, durationMs } = await db.search("SORTIS", 10);
    // Dokładne trafienie nazwy na górze, pod nim pozostałe leki z tą samą substancją (alias „sortis”).
    expect(data.count).toBe(5);
    expect(data.items[0]?.nazwa).toBe("Sortis");
    expect(data.items[0]?.dopasowanie).toBe("nazwa");
    expect(
      data.items.slice(1).every((i) => i.dopasowanie === "alias" && i.substancja_czynna === "Atorvastatinum"),
    ).toBe(true);
    expect(data.items[0]?.liczba_zamiennikow).toBe(4);
    expect(data.items[0]?.najnizsza_doplata_w_grupie).toBe(2.6);
    expect(data.items[0]?.mozliwa_oszczednosc).toBe(82.4);
    expect(durationMs).toBeGreaterThan(0);
  });

  test("wyszukuje po substancji czynnej (INN)", async () => {
    const { data } = await db.search("atorvastatinum", 20);
    expect(data.matchMode).toBe("direct");
    // Same trafienia dokładne – podobne statyny (wyniki przybliżone) nie są dokładane.
    expect(data.count).toBe(5);
    expect(data.items.every((i) => i.dopasowanie === "substancja")).toBe(true);
    expect(new Set(data.items.map((i) => i.substancja_czynna))).toEqual(new Set(["Atorvastatinum"]));
  });

  test("wyszukuje po wskazaniu bez polskich znaków", async () => {
    const { data } = await db.search("nadcisnienie", 50);
    expect(data.count).toBe(13);
    expect(data.items.every((i) => foldText(i.wskazanie).includes("nadcisnienie"))).toBe(true);
    expect(data.items.every((i) => i.dopasowanie === "objawy")).toBe(true);
  });

  test("wyszukuje po kodzie EAN", async () => {
    const { data } = await db.search("5909990010011", 5);
    expect(data.items.map((i) => i.nazwa)).toEqual(["Sortis"]);
  });

  test("dopasowania prefiksu nazwy są na początku listy", async () => {
    const { data } = await db.search("ato", 10);
    expect(data.items[0]?.nazwa.toLowerCase().startsWith("ato")).toBe(true);
  });

  test("respektuje LIMIT", async () => {
    const { data } = await db.search("tabl", 3);
    expect(data.items.length).toBeLessThanOrEqual(3);
    const { data: all } = await db.search("mg", 3);
    expect(all.count).toBeLessThanOrEqual(3);
  });

  test("znaki wieloznaczne nie zwracają całej bazy", async () => {
    const { data } = await db.search("%%", 50);
    expect(data.count).toBe(0);
    const { data: underscore } = await db.search("_____", 50);
    expect(underscore.count).toBe(0);
  });

  test("zapytanie z apostrofem jest bezpieczne (parametryzacja)", async () => {
    const { data } = await db.search("x' OR 1=1 --", 50);
    expect(data.count).toBe(0);
  });

  test("brak oszczędności dla najtańszego leku w grupie", async () => {
    const { data } = await db.search("Atorvastatin Teva", 5);
    expect(data.items[0]?.mozliwa_oszczednosc).toBe(0);
  });

  test("zamienniki: ta sama substancja, dawka i postać, od najtańszego", async () => {
    const { data } = await db.equivalents(1); // Sortis
    expect(data).not.toBeNull();
    const names = data?.zamienniki.map((q) => q.lek.nazwa);
    expect(names).toEqual(["Atorvastatin Teva", "Atorvasterol", "Atoris", "Tulip", "Sortis"]);
    expect(data?.najlepsza_oferta?.lek.nazwa).toBe("Atorvastatin Teva");
    expect(data?.najlepsza_oferta?.oszczednosc_pln).toBe(82.4);
    expect(data?.najlepsza_oferta?.oszczednosc_proc).toBe(96.9);
  });

  test("inna postać (kapsułki) nie jest zamiennikiem tabletek", async () => {
    const polpril = (await db.search("Polpril", 1)).data.items[0];
    expect(polpril?.postac).toBe("kaps. twarde");
    const { data } = await db.equivalents(polpril?.id ?? -1);
    expect(data?.zamienniki).toHaveLength(1);
    expect(data?.najlepsza_oferta).toBeNull();

    const tritace = (await db.search("Tritace", 1)).data.items[0];
    const tabs = await db.equivalents(tritace?.id ?? -1);
    expect(tabs.data?.zamienniki.map((q) => q.lek.nazwa)).not.toContain("Polpril");
    expect(tabs.data?.zamienniki).toHaveLength(4);
  });

  test("przelicza opakowanie 60 szt. względem 30 szt.", async () => {
    const concor = (await db.search("Concor", 1)).data.items[0];
    const { data } = await db.equivalents(concor?.id ?? -1);
    const coronal = data?.zamienniki.find((q) => q.lek.nazwa === "Coronal 5");
    expect(coronal?.przeliczono_na_opakowanie).toBe(true);
    expect(coronal?.doplata_porownawcza).toBe(2.1);
    expect(data?.najlepsza_oferta?.lek.nazwa).toBe("Bisoratio 5");
  });

  test("zwraca null dla nieistniejącego id", async () => {
    const { data } = await db.equivalents(999_999);
    expect(data).toBeNull();
  });

  test("obsługuje równoległe zapytania (pula połączeń)", async () => {
    const queries = Array.from({ length: 25 }, (_, i) =>
      i % 2 === 0
        ? db.search(["sortis", "metform", "amlo", "cukrzyca", "ramipril"][i % 5] as string, 10)
        : db.equivalents((i % 35) + 1),
    );
    const results = await Promise.all(queries);
    expect(results).toHaveLength(25);
    for (const r of results) expect(r.data).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("skrypt fetch_data – funkcje pomocnicze", () => {
  test("scoreDatasetTitle preferuje wykaz leków refundowanych", () => {
    expect(scoreDatasetTitle("Wykaz refundowanych leków – obwieszczenie Ministra Zdrowia")).toBeGreaterThan(
      scoreDatasetTitle("Leki refundowane"),
    );
    expect(scoreDatasetTitle("<mark>Wykaz</mark> <mark>refundowanych</mark> leków")).toBeGreaterThan(0);
    // Archiwalny zbiór statystyczny NFZ (id 1106) nie jest wykazem – odrzucony.
    expect(scoreDatasetTitle("Leki <mark>refundowane</mark>")).toBe(0);
    expect(scoreDatasetTitle("Wartość refundacji – wykaz leków refundowanych 2025")).toBe(0);
    expect(scoreDatasetTitle("Refundowane wyroby medyczne z odpłatnością 30%")).toBe(0);
    expect(scoreDatasetTitle("Ceny mieszkań")).toBe(0);
  });

  test("isRefundValueTitle rozpoznaje zestawienia „Wartość refundacji”", () => {
    expect(isRefundValueTitle("<mark>Wartość</mark> refundacji leków w 2024 r.")).toBe(true);
    expect(isRefundValueTitle("WARTOSC REFUNDACJI")).toBe(true);
    expect(isRefundValueTitle("Wykaz refundowanych leków")).toBe(false);
  });

  test("pickResources sortuje po dacie publikacji i pomija „Wartość refundacji”", () => {
    const picked = pickResources(
      [
        {
          id: "1",
          attributes: {
            title: "Starszy",
            format: "xlsx",
            download_url: "https://x/1.xlsx",
            created: "2026-09-01T10:00:00Z",
            data_date: "2026-10-01",
          },
        },
        {
          id: "2",
          attributes: {
            title: "Wartość refundacji",
            format: "csv",
            download_url: "https://x/2.csv",
            created: "2026-11-20T00:00:00Z",
          },
        },
        {
          id: "3",
          attributes: {
            title: "Najnowszy",
            format: "csv",
            download_url: "https://x/3.csv",
            created: "2026-11-01T08:00:00Z",
            data_date: "2026-09-01",
          },
        },
      ],
      "Wykaz refundowanych leków",
    );
    expect(picked.map((c) => c.url)).toEqual(["https://x/3.csv", "https://x/1.xlsx"]);
  });

  test("pickResources wybiera CSV, konwersję CSV lub XLSX – najnowsze najpierw", () => {
    const picked = pickResources(
      [
        {
          id: "1",
          attributes: { title: "Stary", format: "csv", download_url: "https://x/1.csv", created: "2020-01-01" },
        },
        {
          id: "2",
          attributes: { title: "PDF", format: "pdf", download_url: "https://x/2.pdf", created: "2026-01-01" },
        },
        {
          id: "3",
          attributes: {
            title: "Nowy XLS",
            format: "xls",
            download_url: "https://x/3.xls",
            csv_download_url: "https://x/3.csv",
            created: "2025-01-01",
          },
        },
        {
          id: "4",
          attributes: { title: "XLSX", format: "xlsx", download_url: "https://x/4.xlsx", created: "2024-01-01" },
        },
      ],
      "Leki refundowane",
    );
    expect(picked.map((c) => c.url)).toEqual(["https://x/3.csv", "https://x/4.xlsx", "https://x/1.csv"]);
    expect(picked.map((c) => c.kind)).toEqual(["csv", "xlsx", "csv"]);
  });

  test("decodeText obsługuje UTF-8 i Windows-1250", () => {
    expect(decodeText(new TextEncoder().encode("Nadciśnienie"))).toBe("Nadciśnienie");
    expect(decodeText(new Uint8Array([0x4c, 0xb9, 0x9c, 0xbf]))).toBe("Ląśż");
  });
});

/* -------------------------------------------------------------------------- */

/** Buduje minimalny skoroszyt XLSX (ZIP bez kompresji, komórki inlineStr). */
function buildXlsx(sheets: { name: string; rows: string[][] }[]): Uint8Array {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const col = (i: number) => String.fromCharCode(65 + i);
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ],
    ...sheets.map((s, i): [string, string] => [
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row.map((v, c) => `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("")}</row>`,
        )
        .join("")}</sheetData></worksheet>`,
    ]),
  ];

  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = Bun.hash.crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(lh.buffer), nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

describe("źródło zapasowe gov.pl – parsowanie HTML", () => {
  const base = "https://www.gov.pl/web/zdrowie/obwieszczenia-ministra-zdrowia-lista-lekow-refundowanych";

  test("parseObwieszczeniaList zwraca pełne obwieszczenia od góry, bez sprostowań i zmian", () => {
    const html = `
      <a href="http://www.archiwum.mz.gov.pl/leki/">Archiwalne obwieszczenia Ministra Zdrowia</a>
      <a href="/web/zdrowie/obwieszczenie-16-wrzesnia-2026"> Obwieszczenie Ministra Zdrowia z dnia 16 września 2026 r. w sprawie wykazu refundowanych leków, środków spożywczych</a>
      <a href="/web/zdrowie/zmieniajace-17-czerwca-2026"> Obwieszczenie Ministra Zdrowia zmieniające Obwieszczenie z dnia 17 czerwca 2026 r. w sprawie wykazu refundowanych leków</a>
      <a href="/web/zdrowie/sprostowanie-17-czerwca-2026"> Sprostowanie do obwieszczenia Ministra Zdrowia z dnia 17 czerwca 2026 r. w sprawie wykazu refundowanych leków</a>
      <a href="/web/zdrowie/obwieszczenie-17-czerwca-2026"><span>Obwieszczenie Ministra Zdrowia z dnia 17 czerwca 2026 r. w sprawie wykazu refundowanych lek&oacute;w</span></a>`;
    const links = parseObwieszczeniaList(html.replace("&oacute;", "ó"), base);
    expect(links.map((l) => l.url)).toEqual([
      "https://www.gov.pl/web/zdrowie/obwieszczenie-16-wrzesnia-2026",
      "https://www.gov.pl/web/zdrowie/obwieszczenie-17-czerwca-2026",
    ]);
  });

  test("findWykazXlsx wybiera załącznik XLSX z wykazem, a nie PDF ani pliki pomocnicze", () => {
    const file = (id: string, name: string, format: string) => `
      <a class="file-download" href="/attachment/${id}" target="_blank" download
      aria-label="
      Pobierz plik ${name}
      Rozmiar: 0.86MB
      Format: ${format}">
      ${name}<br/>
      <span class="extension">${name.replaceAll(" ", "&#8203;_")}.${format}</span>
      <span class="details">0.86MB</span>
      </a>`;
    const html = [
      file("a1", "84W podstawa limitu apteka", "xlsx"),
      file("a2", "84W zalacznik do obwieszczenia", "pdf"),
      file("a3", "84W zalacznik do obwieszczenia", "xlsx"),
      file("a4", "84W zmiany cen detalicznych i doplat pacjenta", "xlsx"),
    ].join("\n");
    expect(findWykazXlsx(html, "https://www.gov.pl/web/zdrowie/obwieszczenie")).toEqual({
      url: "https://www.gov.pl/attachment/a3",
      text: "84W zalacznik do obwieszczenia",
    });
    expect(findWykazXlsx(file("x", "84W zalacznik do obwieszczenia", "pdf"), base)).toBeNull();
  });
});

describe("konwersja XLSX → CSV", () => {
  const workbook = () =>
    buildXlsx([
      { name: "Informacje", rows: [["Obwieszczenie Ministra Zdrowia"], ["Załącznik do obwieszczenia"]] },
      {
        name: "A1 & leki",
        rows: [
          ["A1. Leki refundowane dostępne w aptece na receptę"],
          ["Substancja czynna", "Nazwa  postać i dawka", "Zawartość opakowania", "Wysokość dopłaty świadczeniobiorcy"],
          ["Atorvastatinum", "Atoris, tabl. powl., 20 mg", "30 szt.", "12,50 zł"],
          ["Atorvastatinum", "Sortis, tabl. powl., 20 mg", "30 szt.", "35,10 zł"],
        ],
      },
      {
        name: "B",
        rows: [
          ["Substancja czynna", "Nazwa", "Wysokość dopłaty"],
          ["X", "Y", "1,00"],
        ],
      },
    ]);

  test("listXlsxSheets zwraca arkusze w kolejności skoroszytu", () => {
    expect(listXlsxSheets(workbook())).toEqual(["Informacje", "A1 & leki", "B"]);
  });

  test("convertXlsxToCsv wybiera pierwszy arkusz z tabelą leków i daje poprawny Parquet", async () => {
    const xlsxPath = join(workDir, "obwieszczenie.xlsx");
    const csvPath = join(workDir, "obwieszczenie.csv");
    await writeFile(xlsxPath, workbook());
    expect(await convertXlsxToCsv(xlsxPath, csvPath)).toBe("A1 & leki");
    const csv = await readFile(csvPath, "utf8");
    expect(csv).toContain("Atoris");
    expect(csv).not.toContain("Załącznik");

    const parquetPath = join(workDir, "z-xlsx.parquet");
    const meta = await buildParquet({
      inputPath: csvPath,
      kind: "csv",
      parquetPath,
      meta: { source: "parquet", resource_url: null, resource_title: "test" },
    });
    expect(meta.rows).toBe(2);
  });

  test("convertXlsxToCsv zgłasza błąd, gdy żaden arkusz nie zawiera tabeli leków", async () => {
    const xlsxPath = join(workDir, "bez-lekow.xlsx");
    await writeFile(xlsxPath, buildXlsx([{ name: "Arkusz1", rows: [["Ceny mieszkań"], ["a", "b"]] }]));
    await expect(convertXlsxToCsv(xlsxPath, join(workDir, "bez-lekow.csv"))).rejects.toBeInstanceOf(SourceFormatError);
  });
});
