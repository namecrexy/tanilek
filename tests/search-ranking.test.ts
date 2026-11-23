import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeDrug } from "../src/aliases";
import { DrugDatabase, foldText, SEARCH_RANK, symptomStems, symptomText } from "../src/db";
import type { SearchHit, SearchHitMatch } from "../src/types";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");

/** Grupa rankingu z wymagań: dokładna nazwa/alias → substancja i objawy → wyniki przybliżone. */
const GROUP: Record<SearchHitMatch, number> = { nazwa: 0, alias: 0, substancja: 1, objawy: 1, przyblizone: 2 };

function groups(items: readonly SearchHit[]): number[] {
  return items.map((i) => GROUP[i.dopasowanie ?? "przyblizone"]);
}

function isNonDecreasing(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || (values[i - 1] ?? 0) <= v);
}

/** Tekst karty „Na co pomaga” leku (to samo źródło, które przeszukuje baza). */
function naCoPomaga(hit: SearchHit): string {
  const d = describeDrug(hit);
  return foldText(`${d.kategoria} ${d.naCoPomaga} ${hit.wskazanie}`);
}

describe("symptomStems / symptomText", () => {
  test("odcina polskie końcówki, aby objaw pasował do odmian w opisie", () => {
    expect(symptomStems("katar")).toEqual(["katar"]);
    expect(symptomStems("zgaga")).toEqual(["zgag"]);
    expect(symptomStems("Gorączka")).toEqual(["goracz"]);
    expect(symptomStems("ból gardła")).toEqual(["bol", "gard"]);
    expect(symptomStems("bólu głowy")).toEqual(["bol", "glow"]);
  });

  test("pomija słowa pomocnicze, liczby i bardzo krótkie słowa", () => {
    expect(symptomStems("lek na katar")).toEqual(["katar"]);
    expect(symptomStems("Apap 500 mg")).toEqual(["apap"]);
    expect(symptomStems("na i w")).toEqual([]);
  });

  test("odmiany objawu w opisie zawierają rdzeń na początku słowa", () => {
    const opis = symptomText("Łagodzi zgagę, obniża gorączkę; przy katarze i bólu gardła.");
    expect(opis.startsWith(" ") && opis.endsWith(" ")).toBe(true);
    for (const q of ["zgaga", "gorączka", "katar", "ból gardła"]) {
      for (const stem of symptomStems(q)) expect(opis).toContain(` ${stem}`);
    }
  });
});

describe("DrugDatabase – wyszukiwanie po objawach i ranking", () => {
  let workDir: string;
  let db: DrugDatabase;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tanilek-ranking-"));
    db = await DrugDatabase.open({
      dataFilePath: join(workDir, "baza.parquet"),
      fallbackCsvPath: FIXTURE,
      poolSize: 1,
    });
  });

  afterAll(async () => {
    db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  test.each([
    ["katar", ["Otrivin", "Nasivin", "Claritine"]],
    ["zgaga", ["Rennie", "Controloc 20"]],
    ["gorączka", ["Apap", "Ibuprom", "Paracetamol"]],
    ["ból gardła", ["Strepsils", "Tantum Verde"]],
  ])("objaw „%s” zwraca leki, które na niego pomagają", async (query, expected) => {
    const { data } = await db.search(query, 50);
    const names = data.items.map((i) => i.nazwa);
    for (const name of expected) expect(names).toContain(name);
    expect(data.items.every((i) => i.dopasowanie === "objawy")).toBe(true);
    // Każdy wynik naprawdę ma objaw w opisie „Na co pomaga” (lub we wskazaniu).
    const stems = symptomStems(query);
    expect(data.items.every((i) => stems.every((s) => naCoPomaga(i).includes(s)))).toBe(true);
    expect(data.matchMode).toBe("direct");
    expect(data.resolvedNote).toBe(`Pokazuję leki, które pomagają na: ${query}`);
  });

  test("wszystkie słowa objawu muszą pasować („ból gardła” nie zwraca leków tylko na ból)", async () => {
    const gardlo = await db.search("ból gardła", 50);
    const names = gardlo.data.items.map((i) => i.nazwa);
    expect(names).not.toContain("Apap");
    expect(names).not.toContain("Nurofen");
  });

  test("objawy działają z filtrem kategorii, a liczniki obejmują obie kategorie", async () => {
    const all = await db.search("zgaga", 50);
    const otc = await db.search("zgaga", 50, "OTC");
    expect(all.data.liczniki?.Rp).toBeGreaterThan(0);
    expect(all.data.liczniki?.OTC).toBeGreaterThan(0);
    expect(otc.data.liczniki).toEqual(all.data.liczniki as NonNullable<typeof all.data.liczniki>);
    expect(otc.data.items.every((i) => i.kategoriaDostepnosci === "OTC")).toBe(true);
    expect(otc.data.count).toBe(all.data.liczniki?.OTC ?? -1);
  });

  test("zapytanie bez sensu nie dopasowuje opisów", async () => {
    const { data } = await db.search("qwertyzx", 10);
    expect(data.count).toBe(0);
  });

  test("dokładna nazwa na górze, potem alias, dalej substancja – kolejność grup nie maleje", async () => {
    const { data } = await db.search("apap", 50);
    expect(data.items.map((i) => [i.nazwa, i.dopasowanie])).toEqual([
      ["Apap", "nazwa"],
      ["Apap", "nazwa"],
      ["Apap Extra", "nazwa"],
      ["Panadol", "alias"],
      ["Paracetamol", "alias"],
    ]);
    expect(isNonDecreasing(groups(data.items))).toBe(true);
  });

  test("trafienia nazwy wyprzedzają trafienia substancji („paracetamol”)", async () => {
    const { data } = await db.search("paracetamol", 50);
    expect(data.items[0]?.nazwa).toBe("Paracetamol");
    expect(data.items[0]?.dopasowanie).toBe("nazwa");
    expect(data.items.slice(1).every((i) => i.dopasowanie === "substancja")).toBe(true);
  });

  test.each([
    "atorvastatinum",
    "atorwastatyna",
    "sortis",
    "apap",
    "paracetamol",
    "zgaga",
    "ból gardła",
    "5909990010011",
  ])("poprawnie wpisane „%s” nie dostaje wyników przybliżonych", async (q) => {
    const { data } = await db.search(q, 50);
    expect(data.count).toBeGreaterThan(0);
    expect(data.matchMode).not.toBe("fuzzy");
    expect(data.items.some((i) => i.dopasowanie === "przyblizone")).toBe(false);
    expect(isNonDecreasing(groups(data.items))).toBe(true);
  });

  test("wyniki przybliżone nie zawyżają liczników kategorii przy trafieniach dokładnych", async () => {
    // Podobne statyny (Rosuvastatinum) nie są doliczane do 5 leków z atorwastatyną.
    const { data } = await db.search("atorvastatinum", 50);
    expect(data.liczniki).toEqual({ wszystkie: 5, Rp: 5, OTC: 0 });
    expect(data.items.every((i) => i.substancja_czynna === "Atorvastatinum")).toBe(true);
    expect(data.items.map((i) => i.substancja_czynna)).not.toContain("Rosuvastatinum");
  });

  test("brak trafienia w wybranej kategorii nie włącza wyników przybliżonych", async () => {
    // Dokładne trafienia istnieją tylko w Rp – filtr OTC daje pustą listę, a nie „podobne” leki OTC.
    const { data } = await db.search("atorvastatinum", 50, "OTC");
    expect(data.count).toBe(0);
    expect(data.matchMode).toBe("direct");
    expect(data.liczniki).toEqual({ wszystkie: 5, Rp: 5, OTC: 0 });
  });

  test("literówka bez trafień dokładnych zwraca wyłącznie wyniki przybliżone (matchMode „fuzzy”)", async () => {
    const { data } = await db.search("atorwastayna", 20);
    expect(data.matchMode).toBe("fuzzy");
    expect(data.count).toBeGreaterThan(0);
    expect(data.items.every((i) => i.dopasowanie === "przyblizone")).toBe(true);
    expect(data.items[0]?.substancja_czynna).toBe("Atorvastatinum");
    expect(data.liczniki?.wszystkie).toBe((data.liczniki?.Rp ?? 0) + (data.liczniki?.OTC ?? 0));
    expect(data.resolvedNote).toBe("Pokazuję najbardziej zbliżone wyniki dla: atorwastayna");
  });

  test("literówka w nazwie handlowej (Glucofage) – fallback przybliżony", async () => {
    const { data } = await db.search("glucofage", 5);
    expect(data.matchMode).toBe("fuzzy");
    expect(data.items[0]?.nazwa).toBe("Glucophage 850");
  });

  test("kod EAN jest dokładnym trafieniem i ma rangę nazwy", async () => {
    const { data } = await db.search("5909990010011", 5);
    expect(data.items[0]?.nazwa).toBe("Sortis");
    expect(data.items[0]?.dopasowanie).toBe("nazwa");
  });

  test("limit obcina wynik po rankingu (dokładne trafienia mają pierwszeństwo)", async () => {
    const { data } = await db.search("sortis", 1);
    expect(data.items.map((i) => i.nazwa)).toEqual(["Sortis"]);
    expect(data.liczniki?.wszystkie).toBe(5);
  });

  test("rangi są uporządkowane zgodnie z wymaganiami", () => {
    expect(SEARCH_RANK.NAZWA_DOKLADNA).toBeLessThan(SEARCH_RANK.SUBSTANCJA_PREFIKS);
    expect(SEARCH_RANK.ALIAS_DOKLADNY).toBeLessThan(SEARCH_RANK.SUBSTANCJA_PREFIKS);
    expect(SEARCH_RANK.OBJAWY).toBeLessThan(SEARCH_RANK.PRZYBLIZONE);
    expect(Math.max(...Object.values(SEARCH_RANK))).toBe(SEARCH_RANK.PRZYBLIZONE);
  });
});
