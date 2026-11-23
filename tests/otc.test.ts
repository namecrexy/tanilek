import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { atcDescription, describeDrug, fallbackDescription, KNOWN_SUBSTANCES, resolveAlias } from "../src/aliases";
import { ATC_GROUP_COUNT, atcGroup, normalizeAtc } from "../src/atc";
import { TtlLruCache } from "../src/cache";
import {
  buildEquivalents,
  buildFromFallback,
  buildParquet,
  DrugDatabase,
  groupAveragePrice,
  mergeCatalog,
  metaPathFor,
  readRplCsv,
  toSqlPath,
} from "../src/db";
import {
  BUILTIN_OTC,
  estimateOtcPrice,
  extractFromRpl,
  isPermitValid,
  normalizeEan,
  normalizePostac,
  parseRplPackages,
  parseUnits,
} from "../src/otc";
import type { DataMeta, DrugRecord } from "../src/types";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");
const RPL_FIXTURE = resolve(import.meta.dir, "fixtures", "sample_rpl.csv");
const TODAY = "2026-11-23";

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
  workDir = await mkdtemp(join(tmpdir(), "tanilek-otc-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe("kody ATC – normalizacja i grupy", () => {
  test("normalizeAtc: wielkość liter, spacje, wiele kodów i wartości niepoprawne", () => {
    expect(normalizeAtc(" n02be01 ")).toBe("N02BE01");
    expect(normalizeAtc("C05AX03, C05AD01")).toBe("C05AX03");
    expect(normalizeAtc("BRAK")).toBeNull();
    expect(normalizeAtc("")).toBeNull();
    expect(normalizeAtc(null)).toBeNull();
    expect(normalizeAtc("QP52AF02")).toBeNull();
  });

  test("najdłuższy pasujący prefiks wygrywa", () => {
    expect(atcGroup("R05CB02")?.prefix).toBe("R05C");
    expect(atcGroup("R05DB13")?.prefix).toBe("R05D");
    expect(atcGroup("R05X")?.prefix).toBe("R05");
    expect(atcGroup("C05AX03")?.prefix).toBe("C05A");
    expect(atcGroup("C05CA03")?.prefix).toBe("C05");
    expect(atcGroup("L01XC")?.prefix).toBe("L");
    expect(atcGroup(null)).toBeNull();
    expect(ATC_GROUP_COUNT).toBeGreaterThan(50);
  });

  test.each([
    ["N02BE01", "przeciwbólowy i przeciwgorączkowy"],
    ["M01AE01", "przeciwzapalny i przeciwbólowy na stawy i mięśnie"],
    ["R01AA07", "udrażniający nos przy katarze i zapaleniu zatok"],
    ["R02AA20", "ból i stan zapalny gardła"],
    ["R05CB06", "wykrztuśny na kaszel mokry"],
    ["R05DA09", "przeciwkaszlowy na kaszel suchy"],
    ["R06AE07", "przeciwalergiczny"],
    ["A02AD01", "kwas"],
    ["A02BC01", "zgagę, refluks"],
    ["A07DA03", "przeciwbiegunkowy i osłonowy na jelita"],
    ["C05CA03", "żylaki i obrzęki nóg"],
    ["D01AC01", "przeciwgrzybiczy na skórę"],
    ["D07AA02", "przeciwzapalna na zmiany skórne"],
    ["S01GA01", "do oczu"],
    ["A11GA01", "Witaminy"],
    ["A12CC06", "Minerały"],
  ])("prefiks %s → %s", (code, fragment) => {
    const group = atcGroup(code);
    expect(group).not.toBeNull();
    expect((group?.kategoria ?? "").toLowerCase()).toContain(fragment.toLowerCase());
  });
});

describe("opisy leków – słownik OTC i fallback ATC", () => {
  test("słownik zawiera co najmniej 40 substancji typowych dla leków OTC", () => {
    const otcSubstances = [
      "Paracetamolum",
      "Ibuprofenum",
      "Acidum acetylsalicylicum",
      "Xylometazolinum",
      "Oxymetazolinum",
      "Naphazolinum",
      "Pseudoephedrinum",
      "Dexpanthenolum",
      "Loperamidum",
      "Simeticonum",
      "Ambroxolum",
      "Acetylcysteinum",
      "Bromhexinum",
      "Butamirati citras",
      "Dextromethorphanum",
      "Guaifenesinum",
      "Benzydaminum",
      "Cholini salicylas",
      "Flurbiprofenum",
      "Amylmetacresolum",
      "Cetylpyridinii chloridum",
      "Calcii carbonas + Magnesii subcarbonas",
      "Natrii alginas",
      "Racecadotrilum",
      "Bisacodylum",
      "Macrogolum",
      "Sennosidum",
      "Hymecromonum",
      "Drotaverinum",
      "Diosminum",
      "Troxerutinum",
      "Aescinum",
      "Heparinum",
      "Dimetindeni maleas",
      "Clemastinum",
      "Ketotifenum",
      "Tetryzolinum",
      "Hypromellosum",
      "Clotrimazolum",
      "Terbinafinum",
      "Hydrocortisonum",
      "Zinci oxidum",
      "Acidum ascorbicum",
      "Magnesii lactas",
      "Melatoninum",
      "Nicotinum",
      "Pyrantelum",
      "Mebendazolum",
      "Cetirizinum",
      "Loratadinum",
    ];
    expect(otcSubstances.length).toBeGreaterThanOrEqual(40);
    for (const substance of otcSubstances) expect(KNOWN_SUBSTANCES).toContain(substance);
  });

  test.each([
    ["Apap", "Paracetamolum"],
    ["Panadol", "Paracetamolum"],
    ["Ibuprom", "Ibuprofenum"],
    ["Nurofen", "Ibuprofenum"],
    ["Mig", "Ibuprofenum"],
    ["Aspiryna", "Acidum acetylsalicylicum"],
    ["Polopiryna", "Acidum acetylsalicylicum"],
    ["Otrivin", "Xylometazolinum"],
    ["Sudafed Xylospray", "Xylometazolinum"],
    ["Nasivin", "Oxymetazolinum"],
    ["Stoperan", "Loperamidum"],
    ["Laremid", "Loperamidum"],
    ["Espumisan", "Simeticonum"],
    ["Mucosolvan", "Ambroxolum"],
    ["Flavamed", "Ambroxolum"],
    ["ACC", "Acetylcysteinum"],
    ["Sinecod", "Butamirati citras"],
    ["Tantum Verde", "Benzydaminum"],
    ["Cholinex", "Cholini salicylas"],
    ["Strepsils Intensive", "Flurbiprofenum"],
    ["Rennie", "Calcii carbonas + Magnesii subcarbonas"],
    ["No-Spa", "Drotaverinum"],
    ["Diohespan", "Diosminum"],
    ["Diosminex", "Diosminum"],
    ["Fenistil", "Dimetindeni maleas"],
    ["Rutinoscorbin", "Acidum ascorbicum"],
    ["Magne B6", "Magnesii lactas"],
    ["Neo-Angin", "Amylmetacresolum"],
  ])("marka %s → %s", (brand, substance) => {
    expect(resolveAlias(brand)?.substance).toBe(substance);
  });

  test("lek z RPL (substancja w postaci soli) dostaje opis ze słownika", () => {
    const opis = describeDrug({
      nazwa: "Otrivin",
      substancja_czynna: "Xylometazolini hydrochloridum",
      postac: "aerozol do nosa",
      wskazanie: "",
      kodAtc: "R01AA07",
      kategoriaDostepnosci: "OTC",
    });
    expect(opis.zrodlo).toBe("slownik");
    expect(opis.substancja).toBe("Xylometazolinum");
    expect(opis.jakStosowac).toStartWith("Donosowo");
  });

  test("substancja spoza słownika z kodem ATC → automatyczny opis grupy", () => {
    const opis = describeDrug({
      nazwa: "Herbapect",
      substancja_czynna: "Thymi herbae extractum",
      postac: "syrop",
      wskazanie: "",
      kodAtc: "R05CA10",
      kategoriaDostepnosci: "OTC",
    });
    expect(opis.zrodlo).toBe("atc");
    expect(opis.kategoria).toBe("Lek wykrztuśny na kaszel mokry");
    expect(opis.naCoPomaga).toContain("odkrztuszanie");
    expect(opis.jakStosowac).toContain("doustnie");
  });

  test("opis ATC leku refundowanego dołącza konkretne wskazanie MZ, a pomija „wszystkie wskazania”", () => {
    const specific = atcDescription("C10AA05", "tabl. powl.", "Hipercholesterolemia");
    expect(specific?.naCoPomaga).toContain("Refundacja m.in. w: Hipercholesterolemia.");
    const general = atcDescription("C10AA05", "tabl. powl.", "We wszystkich zarejestrowanych wskazaniach");
    expect(general?.naCoPomaga).not.toContain("Refundacja");
  });

  test("lek OTC bez słownika i bez ATC – neutralny opis „bez recepty” zamiast „refundowany”", () => {
    const opis = fallbackDescription("", "granulki", "OTC");
    expect(opis.kategoria).toBe("Lek bez recepty (OTC)");
    expect(opis.naCoPomaga).toContain("bez recepty");
    expect(opis.naCoPomaga).not.toContain("refundowany");
    expect(describeDrug({ nazwa: "X", substancja_czynna: "Nieznanum", postac: "", wskazanie: "" }).kategoria).toBe(
      "Lek refundowany",
    );
  });
});

describe("leki OTC – parsowanie RPL i szacowanie cen", () => {
  test("parseUnits, normalizeEan, normalizePostac", () => {
    expect(parseUnits("24 tabl.")).toBe(24);
    expect(parseUnits("1 inh. po 60 daw.")).toBe(60);
    expect(parseUnits("1 butelka 10 ml")).toBeNull();
    expect(normalizeEan("05909990000011")).toBe("5909990000011");
    expect(normalizeEan("5909990000011")).toBe("5909990000011");
    expect(normalizePostac("Tabletki powlekane")).toBe("tabl. powl.");
    expect(normalizePostac("Kapsułki twarde")).toBe("kaps. twarde");
    expect(normalizePostac("Aerozol do nosa, roztwór")).toBe("aerozol do nosa, roztwór");
  });

  test("parseRplPackages rozpoznaje kategorię, skasowane opakowania i wieloliniowe opisy", () => {
    const packages = parseRplPackages(
      "05909990000011 ¦ OTC ¦ 11\n12 tabl.\n05909990000028 ¦ OTC ¦ Skasowane ¦ 12\n6 tabl.\n05909990000035 ¦ Rp ¦ 13\n100 tabl.\n(10 x 10)",
    );
    expect(packages).toEqual([
      { ean: "5909990000011", kategoria: "OTC", skasowane: false, opis: "12 tabl." },
      { ean: "5909990000028", kategoria: "OTC", skasowane: true, opis: "6 tabl." },
      { ean: "5909990000035", kategoria: "Rp", skasowane: false, opis: "100 tabl. (10 x 10)" },
    ]);
  });

  test("isPermitValid: bezterminowe, przyszła i przeszła data", () => {
    expect(isPermitValid("Bezterminowe", TODAY)).toBe(true);
    expect(isPermitValid("2099-12-31", TODAY)).toBe(true);
    expect(isPermitValid(TODAY, TODAY)).toBe(true);
    expect(isPermitValid("2020-01-01", TODAY)).toBe(false);
  });

  test("estimateOtcPrice: końcówka ,49/,99, większe opakowanie droższe, ale taniej za sztukę", () => {
    const small = estimateOtcPrice("N02BE01", 10) as number;
    const big = estimateOtcPrice("N02BE01", 50) as number;
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    expect(big / 50).toBeLessThan(small / 10);
    for (const price of [small, big, estimateOtcPrice("R01AA07", null) as number]) {
      expect([49, 99]).toContain(Math.round((price * 100) % 100));
    }
    expect(estimateOtcPrice(null, 10)).toBeNull();
    expect(estimateOtcPrice("QP52AF02", 10)).toBeNull();
  });

  test("marka z wbudowanego zestawu: cena z jej znanej ceny rynkowej zamiast ogólnej średniej ATC", () => {
    // Dokładnie to samo opakowanie co w zestawie → ta sama cena.
    expect(estimateOtcPrice("C05CA51", 90, { nazwa: "Rutinoscorbin", dawka: "25 mg + 100 mg" })).toBe(14.99);
    // Większe opakowanie tej samej marki – skalowane od najbliższego (150 szt. = 21,99 zł), a nie od średniej grupy.
    const big = estimateOtcPrice("C05CA51", 210, { nazwa: "RUTINOSCORBIN", dawka: "25 mg + 100 mg" }) as number;
    expect(big).toBeGreaterThan(21.99);
    expect(big).toBeLessThan(35);
    expect(estimateOtcPrice("C05CA51", 210)).toBeGreaterThan(big);
    // Ta sama marka, inna dawka – brak dopasowania (ogólna średnia ATC).
    expect(estimateOtcPrice("N02BE01", 12, { nazwa: "Apap", dawka: "1000 mg" })).toBe(estimateOtcPrice("N02BE01", 12));
    // Nazwa rozszerzona o wariant („Apap Junior”) pasuje do marki „Apap” (ta sama dawka).
    expect(estimateOtcPrice("N02BE01", 12, { nazwa: "Apap Junior", dawka: "500 mg" })).toBe(7.49);
  });

  test("wbudowany zestaw OTC zawiera wymagane marki z orientacyjnymi cenami", () => {
    const names = new Set(BUILTIN_OTC.map((d) => d.nazwa));
    for (const brand of [
      "Apap",
      "Ibuprom",
      "Nurofen",
      "Rutinoscorbin",
      "Strepsils",
      "Espumisan",
      "Voltaren Emulgel",
      "Rennie",
      "Stoperan",
      "Neo-Angin",
    ]) {
      expect(names.has(brand)).toBe(true);
    }
    for (const d of BUILTIN_OTC) {
      expect(d.cena).toBeGreaterThan(0);
      expect(d.kodAtc).not.toBeNull();
    }
  });

  test("readRplCsv + extractFromRpl: tylko ważne, nieskasowane opakowania OTC dla ludzi z kodem ATC", async () => {
    const products = await readRplCsv(RPL_FIXTURE);
    expect(products).toHaveLength(9);
    const extract = extractFromRpl(products, TODAY);
    expect(extract.otc.map((o) => o.kod_ean)).toEqual([
      "5909990000011",
      "5909990000042",
      "5909990010011",
      "5909990000080",
      "5909990000097",
    ]);
    expect(extract.pominieteBezAtc).toBe(1);
    const apap = extract.otc[0];
    expect(apap?.postac).toBe("tabl. powl.");
    expect(apap?.liczba_jednostek).toBe(12);
    expect(apap?.kodAtc).toBe("N02BE01");
    expect(extract.otc.find((o) => o.nazwa === "Hemorol")?.kodAtc).toBe("C05AX03");
    expect(extract.otc.find((o) => o.nazwa === "Hemorol")?.dawka).toBe("");
    // EAN → ATC obejmuje także opakowania Rp (uzupełnianie kodów ATC leków refundowanych).
    expect(extract.atcByEan.get("5909990010080")).toBe("C10AA05");
    expect(extract.atcByEan.get("5909990000035")).toBe("N02BE01");
    expect(extract.atcByEan.has("5909990000059")).toBe(false);
  });
});

describe("średnia cena w grupie zamienników", () => {
  test("groupAveragePrice liczy w groszach i zaokrągla do grosza", () => {
    expect(groupAveragePrice([])).toBe(0);
    expect(groupAveragePrice([{ doplata_porownawcza: 10 }, { doplata_porownawcza: 20 }])).toBe(15);
    expect(
      groupAveragePrice([{ doplata_porownawcza: 0.1 }, { doplata_porownawcza: 0.2 }, { doplata_porownawcza: 0.2 }]),
    ).toBe(0.17);
  });

  test("buildEquivalents zwraca sredniaCena, liczbaWGrupie i roznicaDoSredniej", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 10.88 });
    const result = buildEquivalents(selected, [
      selected,
      drug({ id: 2, doplata_pacjenta: 3.2 }),
      drug({ id: 3, doplata_pacjenta: 28.52 }),
    ]);
    expect(result.liczbaWGrupie).toBe(3);
    expect(result.sredniaCena).toBe(14.2);
    expect(result.roznicaDoSredniej).toBe(-3.32);
  });

  test("średnia uwzględnia przeliczenie na wielkość opakowania wybranego leku", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 10, liczba_jednostek: 30 });
    const result = buildEquivalents(selected, [
      selected,
      drug({ id: 2, doplata_pacjenta: 40, liczba_jednostek: 60 }), // 20 zł za 30 szt.
    ]);
    expect(result.sredniaCena).toBe(15);
    expect(result.roznicaDoSredniej).toBe(-5);
  });

  test("lek droższy od średniej ma dodatnią różnicę", () => {
    const selected = drug({ id: 1, doplata_pacjenta: 30 });
    const result = buildEquivalents(selected, [selected, drug({ id: 2, doplata_pacjenta: 10 })]);
    expect(result.sredniaCena).toBe(20);
    expect(result.roznicaDoSredniej).toBe(10);
  });
});

describe("TtlLruCache", () => {
  test("zwraca zapisane wartości, wygasa po TTL i usuwa najdawniej używany wpis", () => {
    let now = 0;
    const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: 1000, now: () => now });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // „a” staje się najświeższe
    cache.set("c", 3); // usuwa „b”
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    now = 999;
    expect(cache.get("a")).toBe(1);
    now = 2000;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("scalanie katalogu Rp + OTC (Parquet)", () => {
  test("plik z v1.1.0 (bez nowych kolumn) + RPL: zachowuje leki Rp, uzupełnia ATC po EAN, pomija duplikaty EAN", async () => {
    const parquet = join(workDir, "legacy.parquet");
    // Symulacja pliku z v1.1.0: buildParquet, a następnie usunięcie kolumn dodanych w v1.2.0.
    await buildParquet({
      inputPath: FIXTURE,
      kind: "csv",
      parquetPath: parquet,
      meta: { source: "parquet", resource_url: "https://example.org/wykaz.xlsx", resource_title: "Wykaz MZ" },
    });
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const legacy = join(workDir, "legacy-v11.parquet");
    await conn.run(
      `COPY (SELECT * EXCLUDE (kategoriaDostepnosci, czyRefundowany, kodAtc) FROM read_parquet(${toSqlPath(parquet)}))
       TO ${toSqlPath(legacy)} (FORMAT PARQUET)`,
    );
    conn.closeSync();
    instance.closeSync();

    const extract = extractFromRpl(await readRplCsv(RPL_FIXTURE), TODAY);
    const out = join(workDir, "merged.parquet");
    const meta = await mergeCatalog({
      refundedParquet: legacy,
      parquetPath: out,
      otc: extract.otc,
      otcSource: "rpl",
      atcByEan: extract.atcByEan,
      meta: { source: "parquet", resource_url: "https://example.org/wykaz.xlsx", resource_title: "Wykaz MZ" },
    });
    expect(meta.rows_rp).toBe(35);
    expect(meta.rows_otc).toBe(4); // „Sortis OTC (import)” ma EAN leku z wykazu MZ – pominięty
    expect(meta.rows).toBe(39);
    expect(meta.otc_source).toBe("rpl");
    const saved = JSON.parse(await readFile(metaPathFor(out), "utf8")) as DataMeta;
    expect(saved.rows_otc).toBe(4);

    const db = await DrugDatabase.open({ dataFilePath: out, fallbackCsvPath: FIXTURE, poolSize: 1 });
    try {
      const atoris = (await db.search("Atoris", 5)).data.items[0];
      expect(atoris?.kategoriaDostepnosci).toBe("Rp");
      expect(atoris?.czyRefundowany).toBe(true);
      expect(atoris?.kodAtc).toBe("C10AA05");
      const apap = await db.search("Apap", 10);
      expect(apap.data.items.every((i) => i.kategoriaDostepnosci === "OTC" && !i.czyRefundowany)).toBe(true);
      expect(apap.data.items.map((i) => i.doplata_pacjenta).every((p) => p > 0)).toBe(true);
      const ids = (await db.search("a", 500)).data.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      db.close();
    }
  });

  test("ponowne scalenie zastępuje poprzednie pozycje OTC (bez duplikatów)", async () => {
    const parquet = join(workDir, "twice.parquet");
    const first = await buildFromFallback(FIXTURE, parquet);
    const second = await mergeCatalog({
      refundedParquet: parquet,
      parquetPath: parquet,
      otc: BUILTIN_OTC,
      otcSource: "builtin",
      meta: { source: first.source, resource_url: null, resource_title: first.resource_title },
    });
    expect(second.rows_rp).toBe(35);
    expect(second.rows_otc).toBe(BUILTIN_OTC.length);
  });
});

describe("DrugDatabase – filtry Rp/OTC i średnia cena", () => {
  let db: DrugDatabase;

  beforeAll(async () => {
    const parquet = join(workDir, "demo.parquet");
    await buildFromFallback(FIXTURE, parquet);
    db = await DrugDatabase.open({ dataFilePath: parquet, fallbackCsvPath: FIXTURE });
  });

  afterAll(() => db.close());

  test("tryb demo zawiera wbudowane leki OTC", async () => {
    expect(db.meta.rows_otc).toBe(BUILTIN_OTC.length);
    const { data } = await db.search("Rennie", 10);
    expect(data.count).toBeGreaterThan(0);
    expect(data.items[0]?.kategoriaDostepnosci).toBe("OTC");
    expect(data.liczniki).toEqual({ wszystkie: 2, Rp: 0, OTC: 2 });
  });

  test("liczniki kategorii obejmują wszystkie dopasowania niezależnie od filtra", async () => {
    // „um” pasuje do substancji łacińskich w obu kategoriach.
    const all = await db.search("um", 500);
    const rp = await db.search("um", 500, "Rp");
    const otc = await db.search("um", 500, "OTC");
    expect(all.data.liczniki?.Rp).toBeGreaterThan(0);
    expect(all.data.liczniki?.OTC).toBeGreaterThan(0);
    expect(all.data.liczniki).toEqual(rp.data.liczniki as NonNullable<typeof rp.data.liczniki>);
    expect(all.data.liczniki).toEqual(otc.data.liczniki as NonNullable<typeof otc.data.liczniki>);
    expect(rp.data.items.every((i) => i.kategoriaDostepnosci === "Rp")).toBe(true);
    expect(otc.data.items.every((i) => i.kategoriaDostepnosci === "OTC")).toBe(true);
    expect(rp.data.count).toBe(all.data.liczniki?.Rp ?? -1);
    expect(otc.data.count).toBe(all.data.liczniki?.OTC ?? -1);
    expect(all.data.liczniki?.wszystkie).toBe((all.data.liczniki?.Rp ?? 0) + (all.data.liczniki?.OTC ?? 0));
    expect(rp.data.kategoria).toBe("Rp");
  });

  test("filtr bez wyników w kategorii zwraca puste items, ale pełne liczniki", async () => {
    const { data } = await db.search("Atoris", 10, "OTC");
    expect(data.count).toBe(0);
    expect(data.liczniki?.Rp).toBeGreaterThan(0);
    expect(data.liczniki?.OTC).toBe(0);
  });

  test("filtr działa także dla aliasów i wyszukiwania przybliżonego", async () => {
    const alias = await db.search("paracetamol", 50, "OTC");
    expect(alias.data.matchMode).not.toBe("fuzzy");
    expect(alias.data.items.length).toBeGreaterThan(0);
    const fuzzy = await db.search("Atorys", 50, "Rp");
    expect(fuzzy.data.matchMode).toBe("fuzzy");
    expect(fuzzy.data.items.every((i) => i.kategoriaDostepnosci === "Rp")).toBe(true);
  });

  test("każdy wynik ma sredniaCena i liczbaWGrupie zgodne z panelem zamienników", async () => {
    const hit = (await db.search("Atoris", 1)).data.items[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(hit.liczbaWGrupie).toBe(hit.liczba_zamiennikow + 1);
    const eq = (await db.equivalents(hit.id)).data;
    expect(eq?.liczbaWGrupie).toBe(hit.liczbaWGrupie);
    expect(eq?.sredniaCena).toBeCloseTo(hit.sredniaCena, 2);
    expect(eq?.roznicaDoSredniej).toBeCloseTo(hit.doplata_pacjenta - hit.sredniaCena, 2);
  });

  test("grupy zamienników nie mieszają leków Rp i OTC", async () => {
    const otcHit = (await db.search("Apap", 10, "OTC")).data.items[0];
    expect(otcHit).toBeDefined();
    const eq = (await db.equivalents(otcHit?.id ?? 0)).data;
    expect(eq?.zamienniki.every((q) => q.lek.kategoriaDostepnosci === "OTC")).toBe(true);
    expect(eq?.opisSubstancji.substancja).toBe("Paracetamolum");
  });
});
