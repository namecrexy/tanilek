import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ALIAS_CONFLICTS,
  ALIAS_COUNT,
  aliasKey,
  describeDrug,
  fallbackDescription,
  fuzzyCandidates,
  KNOWN_SUBSTANCES,
  matchKnownSubstance,
  normalizePolishSubstance,
  resolveAlias,
  routeHint,
  substanceInfo,
  substanceStem,
} from "../src/aliases";
import { DrugDatabase } from "../src/db";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");

describe("słownik marek i polskich nazw substancji", () => {
  test.each([
    ["apap", "Paracetamolum"],
    ["Panadol", "Paracetamolum"],
    ["ibuprom", "Ibuprofenum"],
    ["Nurofen", "Ibuprofenum"],
    ["relanium", "Diazepamum"],
    ["diazepan", "Diazepamum"],
    ["No-Spa", "Drotaverinum"],
    ["kwas acetylosalicylowy", "Acidum acetylsalicylicum"],
    ["Glucophage", "Metforminum"],
    ["atorwastatyna", "Atorvastatinum"],
    ["lewotyroksyna", "Levothyroxinum"],
    ["ozempic", "Semaglutidum"],
  ])("%s → %s", (query, substance) => {
    expect(resolveAlias(query)?.substance).toBe(substance);
  });

  test("obejmuje ponad 100 substancji i ponad 450 haseł bez konfliktów", () => {
    expect(KNOWN_SUBSTANCES.length).toBeGreaterThan(100);
    expect(ALIAS_COUNT).toBeGreaterThan(450);
    expect(ALIAS_CONFLICTS).toEqual([]);
  });

  test.each([
    ["nurofen", "Ibuprofenum"],
    ["Nurofen Forte", "Ibuprofenum"],
    ["ibuprom max", "Ibuprofenum"],
    ["ketonal", "Ketoprofenum"],
    ["Ketonal Active", "Ketoprofenum"],
    ["acard", "Acidum acetylsalicylicum"],
    ["Polocard", "Acidum acetylsalicylicum"],
    ["augmentin", "Amoxicillinum"],
    ["Doreta", "Tramadolum"],
    ["nimesil", "Nimesulidum"],
    ["movalis", "Meloxicamum"],
    ["Nedal", "Nebivololum"],
    ["polsart", "Telmisartanum"],
    ["Ezehron", "Ezetimibum"],
    ["lipanthyl", "Fenofibratum"],
    ["Trajenta", "Linagliptinum"],
    ["thyrozol", "Thiamazolum"],
    ["duspatalin", "Mebeverinum"],
    ["smecta", "Diosmectitum"],
    ["Berodual", "Fenoterolum"],
    ["fostex", "Beclometasonum"],
    ["hitaxa", "Desloratadinum"],
    ["ACC", "Acetylcysteinum"],
    ["furagina", "Furazidinum"],
    ["Lorafen", "Lorazepamum"],
    ["velaxin", "Venlafaxinum"],
    ["finlepsin", "Carbamazepinum"],
    ["Depakine", "Acidum valproicum"],
  ])("marka %s → %s", (query, substance) => {
    expect(resolveAlias(query)?.substance).toBe(substance);
  });

  test("każda substancja ma kompletny opis po polsku", () => {
    for (const substance of KNOWN_SUBSTANCES) {
      const info = substanceInfo(substance);
      expect(info?.kategoria.length).toBeGreaterThan(3);
      expect(info?.naCoPomaga.length).toBeGreaterThan(20);
      expect(info?.jakStosowac.length).toBeGreaterThan(20);
    }
  });

  test("opis jest dostępny także po marce", () => {
    expect(substanceInfo("nurofen")?.kategoria).toBe("Lek przeciwbólowy i przeciwzapalny");
    expect(substanceInfo("atoris")?.kategoria).toBe("Lek obniżający cholesterol (statyna)");
    expect(substanceInfo("qwertyzx")).toBeNull();
  });

  test("rozpoznaje markę w zapytaniu wielowyrazowym", () => {
    expect(resolveAlias("apap extra 500")).toEqual({ substance: "Paracetamolum", matched: "apap", kind: "brand" });
  });

  test("aliasKey ignoruje wielkość liter, polskie znaki i separatory", () => {
    expect(aliasKey("No-Spa")).toBe("nospa");
    expect(aliasKey("Łódź 2")).toBe("lodz2");
  });

  test("normalizuje polskie końcówki do łacińskich", () => {
    expect(normalizePolishSubstance("atorwastatyna")).toBe("atorvastatinum");
    expect(normalizePolishSubstance("paracetamol")).toBe("paracetamolum");
    expect(normalizePolishSubstance("diazepan")).toBe("diazepamum");
    expect(normalizePolishSubstance("semaglutyd")).toBe("semaglutidum");
    expect(normalizePolishSubstance("abc")).toBeNull();
  });

  test("rdzeń substancji pasuje do odmian z obwieszczenia MZ", () => {
    expect(substanceStem("Metforminum")).toBe("metformin");
    expect("metformini hydrochloridum".includes(substanceStem("Metforminum"))).toBe(true);
    expect("bisoprololi fumaras".includes(substanceStem("Bisoprololum"))).toBe(true);
    expect(substanceStem("Acidum acetylsalicylicum")).toBe("acidum acetylsalicylic");
  });

  test("nieznane słowo nie jest aliasem, a kandydaci fuzzy mają ograniczoną liczbę", () => {
    expect(resolveAlias("xq")).toBeNull();
    expect(fuzzyCandidates("a b c d e f g h").length).toBeLessThanOrEqual(3);
  });
});

describe("opisy substancji – na co pomaga i jak stosować", () => {
  test.each([
    ["Metformini hydrochloridum", "Metforminum"],
    ["Bisoprololi fumaras", "Bisoprololum"],
    ["Levothyroxinum natricum", "Levothyroxinum"],
    ["Levocetirizini dihydrochloridum", "Levocetirizinum"],
    ["Esomeprazolum magnesicum", "Esomeprazolum"],
    ["tert-Butylamini perindoprilum + Amlodipinum", "Perindoprilum"],
    ["Tramadoli hydrochloridum + Paracetamolum", "Tramadolum"],
  ])("%s → %s", (fromMz, substance) => {
    expect(matchKnownSubstance(fromMz)).toBe(substance);
  });

  test("rdzeń musi zaczynać się na granicy słowa", () => {
    expect(matchKnownSubstance("Xyzcetirizinum")).toBeNull();
    expect(matchKnownSubstance("Substantia ignota")).toBeNull();
  });

  test("lek ze słownika dostaje opis substancji", () => {
    const opis = describeDrug({
      nazwa: "Sortis",
      substancja_czynna: "Atorvastatinum",
      postac: "tabl. powl.",
      wskazanie: "Hipercholesterolemia",
    });
    expect(opis.zrodlo).toBe("slownik");
    expect(opis.substancja).toBe("Atorvastatinum");
    expect(opis.kategoria).toBe("Lek obniżający cholesterol (statyna)");
    expect(opis.jakStosowac).toStartWith("Doustnie");
  });

  test("preparat złożony jest oznaczony w opisie", () => {
    const opis = describeDrug({
      nazwa: "Doreta",
      substancja_czynna: "Tramadoli hydrochloridum + Paracetamolum",
      postac: "tabl. powl.",
      wskazanie: "",
    });
    expect(opis.substancja).toBe("Tramadolum");
    expect(opis.naCoPomaga).toContain("Preparat złożony");
  });

  test("nieznana substancja – rozpoznanie po nazwie handlowej", () => {
    const opis = describeDrug({ nazwa: "Nurofen Forte", substancja_czynna: "", postac: "tabl.", wskazanie: "" });
    expect(opis.substancja).toBe("Ibuprofenum");
  });

  test("postać inna niż doustna zmienia wskazówkę stosowania", () => {
    const opis = describeDrug({
      nazwa: "Dexamethasone eye",
      substancja_czynna: "Dexamethasonum",
      postac: "krople do oczu, zawiesina",
      wskazanie: "",
    });
    expect(opis.zrodlo).toBe("slownik");
    expect(opis.jakStosowac).toBe("Zakraplać do worka spojówkowego zgodnie z zaleceniem lekarza.");
  });

  test("lek wziewny w postaci donosowej dostaje wskazówkę donosową", () => {
    const opis = describeDrug({
      nazwa: "Tafen Nasal",
      substancja_czynna: "Budesonidum",
      postac: "aerozol do nosa, zawiesina",
      wskazanie: "",
    });
    expect(opis.jakStosowac).toBe("Stosować donosowo zgodnie z zaleceniem lekarza i ulotką.");
  });

  test.each([
    ["tabl.", "Przyjmować doustnie, popijając wodą zgodnie z zaleceniem lekarza."],
    ["kaps. twarde", "Przyjmować doustnie, popijając wodą zgodnie z zaleceniem lekarza."],
    ["inh.", "Stosować wziewnie zgodnie z instrukcją inhalatora."],
    ["proszek do inhalacji", "Stosować wziewnie zgodnie z instrukcją inhalatora."],
    ["krople do oczu", "Zakraplać do worka spojówkowego zgodnie z zaleceniem lekarza."],
    ["roztwór do wstrzykiwań", "Podawać we wstrzyknięciu lub wlewie zgodnie z zaleceniem lekarza lub pielęgniarki."],
  ])("droga podania dla postaci %p", (postac, text) => {
    expect(routeHint(postac)?.text).toBe(text);
  });

  test("opis zastępczy dla rzadkiej substancji powstaje ze wskazania i postaci", () => {
    const opis = describeDrug({
      nazwa: "Rarissimum",
      substancja_czynna: "Substantia rarissima",
      postac: "tabl.",
      wskazanie: "Choroba Gauchera typu 1; ",
    });
    expect(opis.zrodlo).toBe("ogolny");
    expect(opis.substancja).toBeNull();
    expect(opis.naCoPomaga).toBe("Stosowany m.in. w: Choroba Gauchera typu 1.");
    expect(opis.jakStosowac).toBe("Przyjmować doustnie, popijając wodą zgodnie z zaleceniem lekarza.");
  });

  test("opis zastępczy dla wskazania „we wszystkich zarejestrowanych” i nieznanej postaci", () => {
    const opis = fallbackDescription("We wszystkich zarejestrowanych wskazaniach na dzień wydania decyzji", "");
    expect(opis.naCoPomaga).toContain("ulotka");
    expect(opis.jakStosowac).toBe("Stosować zgodnie z zaleceniem lekarza i ulotką dołączoną do opakowania.");
    expect(fallbackDescription("x".repeat(500), "tabl.").naCoPomaga.length).toBeLessThan(320);
  });
});

describe("DrugDatabase – aliasy i wyszukiwanie przybliżone", () => {
  let workDir: string;
  let db: DrugDatabase;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tanilek-aliasy-"));
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

  test("bezpośrednie trafienie nie ma komunikatu", async () => {
    const { data } = await db.search("Sortis", 10);
    expect(data.matchMode).toBe("direct");
    expect(data.resolvedNote).toBeUndefined();
  });

  test("polska nazwa substancji → łacińska substancja z bazy", async () => {
    const { data } = await db.search("atorwastatyna", 20);
    expect(data.matchMode).toBe("alias");
    expect(data.count).toBe(5);
    expect(data.items.every((i) => i.dopasowanie === "alias" && i.substancja_czynna === "Atorvastatinum")).toBe(true);
    expect(data.resolvedSubstance).toBe("Atorvastatinum");
    expect(data.resolvedNote).toBe("Rozpoznano substancję: Atorvastatinum (dla zapytania: atorwastatyna)");
  });

  test("marka spoza bazy trafia w zamienniki o tej samej substancji (Bibloc → bisoprolol)", async () => {
    const { data } = await db.search("bibloc", 20);
    expect(data.matchMode).toBe("alias");
    expect(new Set(data.items.map((i) => i.substancja_czynna))).toEqual(new Set(["Bisoprololi fumaras"]));
  });

  test("literówka uruchamia jaro_winkler_similarity", async () => {
    const { data } = await db.search("atorwastayna", 20);
    expect(data.matchMode).toBe("fuzzy");
    expect(data.count).toBeGreaterThan(0);
    // Najbardziej podobne (Atorvastatinum) na początku; dalej ewentualnie inne statyny.
    expect(data.items.slice(0, 5).every((i) => i.substancja_czynna === "Atorvastatinum")).toBe(true);
    expect(data.resolvedNote).toBe("Pokazuję najbardziej zbliżone wyniki dla: atorwastayna");
  });

  test("literówka w nazwie handlowej (Glucofage)", async () => {
    const { data } = await db.search("glucofage", 5);
    expect(data.matchMode).toBe("fuzzy");
    expect(data.items[0]?.nazwa).toBe("Glucophage 850");
  });

  test("bezsensowna fraza nadal zwraca 0 wyników", async () => {
    const { data } = await db.search("qwertyzx", 10);
    expect(data.count).toBe(0);
    expect(data.resolvedNote).toBeUndefined();
  });
});
