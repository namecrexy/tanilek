/**
 * Leki bez recepty (OTC) w bazie TaniLek.
 *
 * Źródła:
 *  1. Rejestr Produktów Leczniczych (RPL, rejestry.ezdrowie.gov.pl) – eksport CSV z kategorią
 *     dostępności każdego opakowania („EAN ¦ OTC ¦ id”). RPL nie zawiera cen, więc cena OTC
 *     jest **szacunkiem** ({@link estimateOtcPrice}) na podstawie typowych cen rynkowych w grupie ATC.
 *  2. Wbudowany zestaw popularnych leków OTC ({@link BUILTIN_OTC}) z orientacyjnymi średnimi cenami
 *     rynkowymi – używany, gdy RPL jest niedostępny (brak sieci, awaria API), oraz w trybie demo.
 *
 * Ceny leków bez recepty nie są regulowane ustawowo i różnią się między aptekami – interfejs
 * zawsze to komunikuje i odsyła do KtoMaLek / GdziePoLek.
 * Moduł jest czysty (bez I/O) – w pełni testowalny jednostkowo.
 */
import { normalizeAtc } from "./atc";

/** Pozycja OTC gotowa do zapisania w pliku Parquet (bez `id` – nadawane przy scalaniu). */
export interface OtcRecord {
  nazwa: string;
  substancja_czynna: string;
  dawka: string;
  postac: string;
  opakowanie: string;
  liczba_jednostek: number | null;
  kod_ean: string;
  /** Orientacyjna średnia cena rynkowa opakowania (PLN). */
  cena: number;
  kodAtc: string | null;
}

/** Domyślny adres eksportu CSV Rejestru Produktów Leczniczych. */
export const RPL_CSV_URL = "https://rejestry.ezdrowie.gov.pl/api/rpl/medicinal-products/public-pl-report/get-csv";

/* -------------------------------------------------------------------------- */
/*  Wbudowany zestaw popularnych leków OTC                                    */
/* -------------------------------------------------------------------------- */

type BuiltinRow = [
  nazwa: string,
  substancja: string,
  dawka: string,
  postac: string,
  opakowanie: string,
  cena: number,
  atc: string,
];

/**
 * Popularne leki bez recepty z orientacyjnymi średnimi cenami rynkowymi (PLN, 2026 r.).
 * Ceny są przybliżone – służą do porównania rzędu wielkości, a nie jako cena w konkretnej aptece.
 */
const BUILTIN_ROWS: readonly BuiltinRow[] = [
  ["Apap", "Paracetamolum", "500 mg", "tabl. powl.", "12 szt.", 7.49, "N02BE01"],
  ["Apap", "Paracetamolum", "500 mg", "tabl. powl.", "24 szt.", 11.99, "N02BE01"],
  ["Panadol", "Paracetamolum", "500 mg", "tabl. powl.", "24 szt.", 12.49, "N02BE01"],
  ["Paracetamol", "Paracetamolum", "500 mg", "tabl. powl.", "24 szt.", 5.49, "N02BE01"],
  ["Apap Extra", "Paracetamolum + Coffeinum", "500 mg + 65 mg", "tabl. powl.", "24 szt.", 16.99, "N02BE51"],
  ["Ibuprom", "Ibuprofenum", "200 mg", "tabl. powl.", "10 szt.", 8.99, "M01AE01"],
  ["Ibuprom", "Ibuprofenum", "200 mg", "tabl. powl.", "50 szt.", 22.99, "M01AE01"],
  ["Nurofen", "Ibuprofenum", "200 mg", "tabl. powl.", "24 szt.", 16.99, "M01AE01"],
  ["Ibuprofen", "Ibuprofenum", "200 mg", "tabl. powl.", "20 szt.", 6.49, "M01AE01"],
  ["Ibuprom Max", "Ibuprofenum", "400 mg", "tabl. powl.", "24 szt.", 17.99, "M01AE01"],
  ["Nurofen Forte", "Ibuprofenum", "400 mg", "tabl. powl.", "12 szt.", 15.49, "M01AE01"],
  ["Polopiryna S", "Acidum acetylsalicylicum", "300 mg", "tabl.", "20 szt.", 9.99, "N02BA01"],
  ["Rutinoscorbin", "Rutosidum + Acidum ascorbicum", "25 mg + 100 mg", "tabl. powl.", "90 szt.", 14.99, "C05CA51"],
  ["Rutinoscorbin", "Rutosidum + Acidum ascorbicum", "25 mg + 100 mg", "tabl. powl.", "150 szt.", 21.99, "C05CA51"],
  [
    "Strepsils",
    "Amylmetacresolum + Alcoholum dichlorobenzylicum",
    "0,6 mg + 1,2 mg",
    "pastylki twarde",
    "24 szt.",
    19.99,
    "R02AA20",
  ],
  ["Strepsils Intensive", "Flurbiprofenum", "8,75 mg", "pastylki twarde", "16 szt.", 22.99, "R02AX01"],
  [
    "Neo-Angin",
    "Amylmetacresolum + Alcoholum dichlorobenzylicum + Levomentholum",
    "0,6 mg + 1,2 mg + 5,9 mg",
    "pastylki twarde",
    "24 szt.",
    17.49,
    "R02AA20",
  ],
  ["Espumisan", "Simeticonum", "40 mg", "kaps. miękkie", "50 szt.", 15.99, "A03AX13"],
  ["Espumisan", "Simeticonum", "40 mg", "kaps. miękkie", "100 szt.", 24.99, "A03AX13"],
  ["Voltaren Emulgel", "Diclofenacum diethylammonium", "11,6 mg/g", "żel", "1 tuba 100 g", 34.99, "M02AA15"],
  ["Voltaren Max", "Diclofenacum diethylammonium", "23,2 mg/g", "żel", "1 tuba 100 g", 49.99, "M02AA15"],
  ["Rennie", "Calcii carbonas + Magnesii subcarbonas", "680 mg + 80 mg", "tabl. do żucia", "24 szt.", 12.99, "A02AX"],
  ["Rennie", "Calcii carbonas + Magnesii subcarbonas", "680 mg + 80 mg", "tabl. do żucia", "48 szt.", 19.99, "A02AX"],
  ["Stoperan", "Loperamidi hydrochloridum", "2 mg", "kaps. twarde", "8 szt.", 9.99, "A07DA03"],
  ["Stoperan", "Loperamidi hydrochloridum", "2 mg", "kaps. twarde", "18 szt.", 15.99, "A07DA03"],
  ["Laremid", "Loperamidi hydrochloridum", "2 mg", "tabl.", "30 szt.", 13.49, "A07DA03"],
  ["Otrivin", "Xylometazolini hydrochloridum", "1 mg/ml", "aerozol do nosa", "1 butelka 10 ml", 16.99, "R01AA07"],
  ["Nasivin", "Oxymetazolini hydrochloridum", "0,5 mg/ml", "aerozol do nosa", "1 butelka 10 ml", 18.99, "R01AA05"],
  ["Sinecod", "Butamirati citras", "1,5 mg/ml", "syrop", "1 butelka 200 ml", 22.99, "R05DB13"],
  ["ACC Optima", "Acetylcysteinum", "600 mg", "tabl. musujące", "10 szt.", 21.99, "R05CB01"],
  ["Mucosolvan", "Ambroxoli hydrochloridum", "30 mg/5 ml", "syrop", "1 butelka 100 ml", 19.99, "R05CB06"],
  [
    "Tantum Verde",
    "Benzydamini hydrochloridum",
    "1,5 mg/ml",
    "aerozol do stosowania w jamie ustnej",
    "1 butelka 30 ml",
    27.99,
    "A01AD02",
  ],
  ["No-Spa Max", "Drotaverini hydrochloridum", "80 mg", "tabl.", "20 szt.", 19.99, "A03AD02"],
  ["Diohespan max", "Diosminum", "1000 mg", "tabl.", "30 szt.", 34.99, "C05CA03"],
  ["Fenistil", "Dimetindeni maleas", "1 mg/g", "żel", "1 tuba 30 g", 21.99, "D04AA13"],
  [
    "Magne B6",
    "Magnesii lactas + Pyridoxini hydrochloridum",
    "48 mg + 5 mg",
    "tabl. powl.",
    "50 szt.",
    24.99,
    "A12CC06",
  ],
  ["Allertec", "Cetirizini dihydrochloridum", "10 mg", "tabl. powl.", "20 szt.", 12.99, "R06AE07"],
  ["Claritine", "Loratadinum", "10 mg", "tabl.", "10 szt.", 14.99, "R06AX13"],
];

/** Wbudowany zestaw popularnych leków OTC z orientacyjnymi średnimi cenami rynkowymi. */
export const BUILTIN_OTC: readonly OtcRecord[] = Object.freeze(
  BUILTIN_ROWS.map(([nazwa, substancja, dawka, postac, opakowanie, cena, atc]) => ({
    nazwa,
    substancja_czynna: substancja,
    dawka,
    postac,
    opakowanie,
    liczba_jednostek: parseUnits(opakowanie),
    kod_ean: "",
    cena,
    kodAtc: normalizeAtc(atc),
  })),
);

/* -------------------------------------------------------------------------- */
/*  Narzędzia                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Liczba jednostek w opakowaniu („30 szt.”, „20 tabl.”, „1 inh. po 60 daw.”) – odpowiednik
 * wyrażenia SQL z `buildNormalizedSelect` (dawki inhalatora mają pierwszeństwo).
 */
export function parseUnits(opakowanie: string): number | null {
  const text = opakowanie.toLowerCase();
  const doses = /(\d+)\s*daw/.exec(text);
  if (doses) return Number(doses[1]);
  const units =
    /(\d+)\s*(szt|tabl|kaps|sasz|amp|fiol|wstrz|wkł|wkl|plast|czop|tab|draż|draz|pastyl|wkładek|wkladek)/.exec(text);
  return units ? Number(units[1]) : null;
}

/** EAN-14 z wiodącym zerem („05909990789214”) → EAN-13, jak w obwieszczeniu MZ. */
export function normalizeEan(raw: string): string {
  const digits = raw.trim().replace(/\D/g, "");
  return /^0\d{13}$/.test(digits) ? digits.slice(1) : digits;
}

/** Skróty postaci farmaceutycznych zgodne z zapisem obwieszczenia MZ. */
const POSTAC_SKROTY: readonly [RegExp, string][] = [
  [/^tabletki powlekane$/i, "tabl. powl."],
  [/^tabletki musujące$/i, "tabl. musujące"],
  [/^tabletki do ssania$/i, "tabl. do ssania"],
  [/^tabletki do rozgryzania i żucia$/i, "tabl. do żucia"],
  [/^tabletki do żucia$/i, "tabl. do żucia"],
  [/^tabletki dojelitowe$/i, "tabl. dojelitowe"],
  [/^tabletki o przedłużonym uwalnianiu$/i, "tabl. o przedł. uwalnianiu"],
  [/^tabletki$/i, "tabl."],
  [/^kapsułki twarde$/i, "kaps. twarde"],
  [/^kapsułki miękkie$/i, "kaps. miękkie"],
  [/^kapsułki$/i, "kaps."],
];

/** Skraca postać z RPL („Tabletki powlekane”) do formy MZ („tabl. powl.”); inne – małymi literami. */
export function normalizePostac(postac: string): string {
  const value = postac.trim().replace(/\s+/g, " ");
  for (const [pattern, short] of POSTAC_SKROTY) if (pattern.test(value)) return short;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/* -------------------------------------------------------------------------- */
/*  Szacowanie cen OTC                                                        */
/* -------------------------------------------------------------------------- */

interface PriceRef {
  /** Typowa cena opakowania referencyjnego (PLN). */
  pack: number;
  /** Liczba jednostek w opakowaniu referencyjnym (null – cena za opakowanie niezależnie od wielkości). */
  units: number | null;
}

/**
 * Typowe ceny rynkowe opakowań OTC w grupach ATC (najdłuższy prefiks wygrywa).
 * Wartości przybliżone na podstawie popularnych produktów – wyłącznie do szacunku rzędu wielkości.
 */
const ATC_PRICE_REFS: readonly [string, PriceRef][] = [
  ["N02BE", { pack: 8.99, units: 20 }],
  ["N02BA", { pack: 9.99, units: 20 }],
  ["N02B", { pack: 12.99, units: 20 }],
  ["M01AE", { pack: 12.99, units: 20 }],
  ["M01A", { pack: 15.99, units: 20 }],
  ["M02A", { pack: 26.99, units: null }],
  ["R05C", { pack: 19.99, units: 20 }],
  ["R05D", { pack: 21.99, units: 20 }],
  ["R05", { pack: 19.99, units: 20 }],
  ["R01A", { pack: 16.99, units: null }],
  ["R02A", { pack: 18.99, units: 24 }],
  ["R06A", { pack: 13.99, units: 10 }],
  ["A01A", { pack: 19.99, units: null }],
  ["A02A", { pack: 13.99, units: 24 }],
  ["A02B", { pack: 19.99, units: 14 }],
  ["A03", { pack: 16.99, units: 30 }],
  ["A05", { pack: 24.99, units: 30 }],
  ["A06A", { pack: 15.99, units: 30 }],
  ["A07", { pack: 14.99, units: 10 }],
  ["A09", { pack: 29.99, units: 20 }],
  ["A11", { pack: 19.99, units: 30 }],
  ["A12", { pack: 19.99, units: 30 }],
  ["B01A", { pack: 12.99, units: 30 }],
  ["B03", { pack: 24.99, units: 30 }],
  ["C05A", { pack: 24.99, units: null }],
  ["C05", { pack: 29.99, units: 30 }],
  ["D01", { pack: 21.99, units: null }],
  ["D", { pack: 19.99, units: null }],
  ["G01", { pack: 24.99, units: 6 }],
  ["G04", { pack: 29.99, units: 30 }],
  ["J05", { pack: 16.99, units: null }],
  ["N05C", { pack: 19.99, units: 20 }],
  ["N06", { pack: 34.99, units: 30 }],
  ["N07B", { pack: 69.99, units: 30 }],
  ["N07C", { pack: 14.99, units: 10 }],
  ["P", { pack: 14.99, units: null }],
  ["S01", { pack: 22.99, units: null }],
  ["S02", { pack: 19.99, units: null }],
  ["A", { pack: 19.99, units: 30 }],
  ["C", { pack: 24.99, units: 30 }],
  ["G", { pack: 24.99, units: null }],
  ["M", { pack: 19.99, units: 20 }],
  ["N", { pack: 19.99, units: 20 }],
  ["R", { pack: 19.99, units: null }],
];

const PRICE_REFS_BY_LENGTH = [...ATC_PRICE_REFS].sort((a, b) => b[0].length - a[0].length);

/** Zaokrąglenie „rynkowe” do końcówki ,49 lub ,99 (np. 12,30 → 12,49; 12,80 → 12,99). */
function marketRound(value: number): number {
  const halves = Math.ceil(value * 2) / 2;
  return Math.max(0.99, Math.round((halves - 0.01) * 100) / 100);
}

/** Cena opakowania przeskalowana z opakowania referencyjnego (większe – taniej za sztukę). */
function scalePrice(ref: PriceRef, liczbaJednostek: number | null): number {
  if (ref.units === null || liczbaJednostek === null || liczbaJednostek <= 0) return marketRound(ref.pack);
  // Wykładnik < 1: większe opakowania są tańsze w przeliczeniu na sztukę; granice chronią przed skrajnościami.
  const factor = Math.min(4, Math.max(0.4, (liczbaJednostek / ref.units) ** 0.75));
  return marketRound(ref.pack * factor);
}

/** Klucz porównawczy nazwy handlowej (małe litery, bez znaków diakrytycznych i separatorów). */
function brandKey(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ł", "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Cena referencyjna z wbudowanego zestawu dla tej samej marki i dawki (np. „Rutinoscorbin” 25 mg + 100 mg):
 * najbliższa wielkością opakowania pozycja z {@link BUILTIN_OTC}. Dzięki temu popularne marki z RPL
 * dostają cenę opartą na znanej cenie rynkowej, a nie na ogólnej średniej grupy ATC.
 */
export function builtinPriceRef(nazwa: string, dawka: string, liczbaJednostek: number | null): PriceRef | null {
  const name = brandKey(nazwa);
  const dose = brandKey(dawka);
  let best: OtcRecord | null = null;
  for (const item of BUILTIN_OTC) {
    const brand = brandKey(item.nazwa);
    if (!(name === brand || name.startsWith(`${brand} `)) || brandKey(item.dawka) !== dose) continue;
    // Przy kilku pozycjach marki (np. 50 i 100 kaps.) – najbliższa wielkością opakowania.
    const distance = (d: OtcRecord) =>
      liczbaJednostek === null || d.liczba_jednostek === null
        ? 0
        : Math.abs(Math.log(d.liczba_jednostek / liczbaJednostek));
    if (best === null || distance(item) < distance(best)) best = item;
  }
  return best ? { pack: best.cena, units: best.liczba_jednostek } : null;
}

/**
 * Szacuje orientacyjną cenę rynkową opakowania leku OTC: według znanej ceny tej samej marki i dawki
 * z wbudowanego zestawu, a w pozostałych przypadkach – według typowej ceny w grupie ATC i wielkości
 * opakowania. Zwraca null, gdy brak kodu ATC lub grupy referencyjnej – takie produkty (głównie
 * homeopatyczne i roślinne bez kodu ATC) nie trafiają do bazy, aby nie pokazywać cen bez żadnej podstawy.
 */
export function estimateOtcPrice(
  kodAtc: string | null,
  liczbaJednostek: number | null,
  brand?: { nazwa: string; dawka: string },
): number | null {
  const atc = normalizeAtc(kodAtc);
  if (atc === null) return null;
  const known = brand ? builtinPriceRef(brand.nazwa, brand.dawka, liczbaJednostek) : null;
  if (known) return scalePrice(known, liczbaJednostek);
  const ref = PRICE_REFS_BY_LENGTH.find(([prefix]) => atc.startsWith(prefix))?.[1];
  if (!ref) return null;
  return scalePrice(ref, liczbaJednostek);
}

/* -------------------------------------------------------------------------- */
/*  Parsowanie eksportu RPL                                                   */
/* -------------------------------------------------------------------------- */

/** Jedno opakowanie z kolumny „Opakowanie” eksportu RPL. */
export interface RplPackage {
  ean: string;
  /** Kategoria dostępności, np. „OTC”, „Rp”, „Rpz”, „Rpw”, „Lz”. */
  kategoria: string;
  /** True, gdy opakowanie oznaczono jako „Skasowane”. */
  skasowane: boolean;
  /** Opis opakowania, np. „20 tabl.”, „1 butelka 200 ml”. */
  opis: string;
}

const PACKAGE_HEADER = /^(\d{8,14})\s*¦\s*([^¦]+?)\s*¦\s*(?:(Skasowane)\s*¦\s*)?\d+\s*$/;

/**
 * Parsuje kolumnę „Opakowanie”, np.:
 * ```
 * 05909990789214 ¦ OTC ¦ 121
 * 20 tabl.
 * 05909990795413 ¦ OTC ¦ Skasowane ¦ 146
 * 10 tabl.
 * ```
 */
export function parseRplPackages(raw: string): RplPackage[] {
  const packages: RplPackage[] = [];
  let current: RplPackage | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = PACKAGE_HEADER.exec(trimmed);
    if (header) {
      current = {
        ean: normalizeEan(header[1] as string),
        kategoria: (header[2] as string).trim(),
        skasowane: header[3] !== undefined,
        opis: "",
      };
      packages.push(current);
    } else if (current) {
      current.opis = current.opis ? `${current.opis} ${trimmed}` : trimmed;
    }
  }
  return packages;
}

/** Wiersz eksportu RPL (tylko kolumny używane przez TaniLek). */
export interface RplProduct {
  nazwa: string;
  /** „Nazwa powszechnie stosowana” – łacińska nazwa substancji czynnej. */
  substancja: string;
  rodzaj: string;
  moc: string;
  postac: string;
  kodAtc: string | null;
  opakowanie: string;
  /** „Bezterminowe” lub data RRRR-MM-DD. */
  waznosc: string;
}

/** True, gdy pozwolenie jest ważne w podanym dniu („Bezterminowe” lub data ≥ dziś). */
export function isPermitValid(waznosc: string, today: string): boolean {
  const value = waznosc.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  return value >= today;
}

export interface RplExtract {
  /** Opakowania OTC z oszacowaną ceną. */
  otc: OtcRecord[];
  /** EAN → kod ATC dla wszystkich opakowań (także Rp) – uzupełnia kody ATC leków refundowanych. */
  atcByEan: Map<string, string>;
  /** Liczba opakowań OTC pominiętych z powodu braku kodu ATC (brak podstawy do szacunku ceny). */
  pominieteBezAtc: number;
}

/**
 * Wybiera z produktów RPL opakowania OTC dla ludzi (bez skasowanych i wygasłych pozwoleń)
 * i buduje mapę EAN → ATC dla całego rejestru.
 */
export function extractFromRpl(products: Iterable<RplProduct>, today: string): RplExtract {
  const otc: OtcRecord[] = [];
  const atcByEan = new Map<string, string>();
  const seen = new Set<string>();
  let pominieteBezAtc = 0;
  for (const product of products) {
    const atc = normalizeAtc(product.kodAtc);
    const packages = parseRplPackages(product.opakowanie ?? "");
    if (atc) for (const p of packages) if (p.ean) atcByEan.set(p.ean, atc);
    if (product.rodzaj?.trim() !== "Ludzki" || !isPermitValid(product.waznosc ?? "", today)) continue;
    const nazwa = (product.nazwa ?? "").trim();
    const substancja = (product.substancja ?? "").trim();
    if (!nazwa || !substancja) continue;
    for (const p of packages) {
      if (p.kategoria !== "OTC" || p.skasowane || !p.ean || seen.has(p.ean)) continue;
      const units = parseUnits(p.opis);
      const rawMoc = (product.moc ?? "").trim();
      const dawka = rawMoc === "-" ? "" : rawMoc;
      const cena = estimateOtcPrice(atc, units, { nazwa, dawka });
      if (cena === null) {
        pominieteBezAtc++;
        continue;
      }
      seen.add(p.ean);
      otc.push({
        nazwa,
        substancja_czynna: substancja,
        dawka,
        postac: normalizePostac(product.postac ?? ""),
        opakowanie: p.opis,
        liczba_jednostek: units,
        kod_ean: p.ean,
        cena,
        kodAtc: atc,
      });
    }
  }
  return { otc, atcByEan, pominieteBezAtc };
}
