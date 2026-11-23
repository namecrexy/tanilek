/**
 * Pobiera wykaz leków refundowanych z API dane.gov.pl i zapisuje go jako `data/leki.parquet`.
 *
 * Kolejność wyboru źródła:
 *   1. SOURCE_URL – bezpośredni adres pliku CSV/XLSX (np. obwieszczenie MZ),
 *   2. DANE_GOV_DATASET_ID – konkretny zbiór danych na dane.gov.pl,
 *   3. wyszukiwanie w katalogu dane.gov.pl kolejno frazami z DANE_GOV_SEARCH_QUERY
 *      (domyślnie „wykaz refundowanych leków” oraz „obwieszczenie Ministra Zdrowia w sprawie
 *      wykazu refundowanych leków”). Brane są tylko zbiory z „wykaz”/„obwieszczenie” w tytule,
 *      z pominięciem zestawień „Wartość refundacji”; zasoby – od najnowszej daty publikacji.
 *
 *   4. gdy dane.gov.pl nie dostarczy wykazu – załącznik XLSX („… zalacznik do obwieszczenia”)
 *      z najnowszego obwieszczenia na stronie MZ (MZ_OBWIESZCZENIA_URL, „off” wyłącza).
 *   5. gdy żadne źródło MZ nie jest dostępne, a istniejący `data/leki.parquet` zawiera pełny wykaz
 *      refundacyjny – dotychczasowe leki Rp są zachowywane (zamiast przejścia w tryb demo).
 *
 * Etap OTC (v1.2.0): po zbudowaniu wykazu Rp pobierany jest eksport CSV Rejestru Produktów
 * Leczniczych (RPL_CSV_URL). Opakowania z kategorią dostępności „OTC” trafiają do bazy jako leki bez
 * recepty (z orientacyjną ceną szacowaną po grupie ATC), a kody ATC z RPL uzupełniają leki refundowane
 * (po EAN). Gdy RPL jest niedostępny – dołączany jest wbudowany zestaw popularnych leków OTC.
 *
 * Pobieranie plików pokazuje w konsoli pasek postępu: `[████░░░░░░] 42% · 1.8 MB / 4.3 MB`.
 *
 * Zasoby XLSX są przed wczytaniem konwertowane do CSV (pierwszy arkusz z tabelą leków – w
 * obwieszczeniu jest to arkusz „A1”: leki dostępne w aptece na receptę).
 * Każdy kandydat jest pobierany, normalizowany i walidowany przez DuckDB. Jeżeli żaden
 * nie spełni wymagań (brak sieci, błąd API, zmiana formatu pliku), skrypt automatycznie
 * buduje bazę z próbki `tests/fixtures/sample_leki.csv` – aplikacja zawsze ma dane.
 *
 * Użycie:
 *   bun run fetch-data              # pobranie z API, w razie problemów tryb demo
 *   bun run fetch-data --demo       # tylko zbudowanie bazy z próbki (bez sieci)
 *   bun run fetch-data --strict     # błąd (kod 1) zamiast trybu demo – np. w automatyzacji
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AppConfig, ConfigError, loadConfig } from "../src/config";
import {
  buildFromFallback,
  buildParquet,
  convertXlsxToCsv,
  foldText,
  isValidParquet,
  mergeCatalog,
  metaPathFor,
  readRplCsv,
  type SourceKind,
} from "../src/db";
import { BUILTIN_OTC, extractFromRpl } from "../src/otc";
import type { DataMeta } from "../src/types";

export interface SourceCandidate {
  url: string;
  kind: SourceKind;
  title: string;
  /** Data publikacji zasobu na dane.gov.pl (ISO), jeśli znana. */
  published?: string;
}

interface ApiResource {
  id: string;
  attributes: {
    title?: string;
    format?: string | null;
    download_url?: string | null;
    csv_download_url?: string | null;
    created?: string;
    data_date?: string | null;
  };
}

interface ApiDataset {
  id: string;
  attributes: { title?: string; formats?: string[] };
}

/** Maksymalna liczba plików pobranych w jednym przebiegu. */
const MAX_ATTEMPTS = 5;
/** Ochrona przed pobraniem nieoczekiwanie ogromnego pliku. */
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
/** Prawdziwy wykaz liczy tysiące pozycji – mniejszy wynik oznacza niewłaściwy plik. */
const MIN_ROWS_FROM_API = 100;
const USER_AGENT = "TaniLek-data-fetcher/1.2";
/** Szerokość paska postępu w znakach. */
const PROGRESS_WIDTH = 10;

/* -------------------------------------------------------------------------- */
/*  Pasek postępu pobierania                                                  */
/* -------------------------------------------------------------------------- */

/** Rozmiar w MB z jednym miejscem po przecinku (kropka – czytelne w logach CI). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pasek postępu pobierania, np. `[████░░░░░░] 42% · 1.8 MB / 4.3 MB`.
 * Gdy serwer nie podał rozmiaru (`total` ≤ 0) – tylko liczba pobranych MB.
 */
export function formatProgressBar(received: number, total: number, width = PROGRESS_WIDTH): string {
  if (!(total > 0)) return `[${"░".repeat(width)}] ${formatMegabytes(received)}`;
  const ratio = Math.min(1, Math.max(0, received / total));
  const filled = Math.round(ratio * width);
  const percent = Math.floor(ratio * 100);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${percent}% · ${formatMegabytes(received)} / ${formatMegabytes(total)}`;
}

/**
 * Czyta treść odpowiedzi strumieniowo, rysując pasek postępu. W terminalu pasek odświeża się
 * w jednej linii (``), a w logach (CI, Docker) wypisywany jest co 25% – bez zalewania logów.
 */
export async function readWithProgress(
  response: Response,
  label: string,
  options: { maxBytes?: number; write?: (chunk: string) => void; isTty?: boolean } = {},
): Promise<Uint8Array> {
  // Przy treści skompresowanej (Content-Encoding) Content-Length nie odpowiada rozmiarowi po dekompresji.
  const encoded = (response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity";
  let total = encoded ? 0 : Number(response.headers.get("content-length") ?? "0");
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const isTty = options.isTty ?? Boolean(process.stdout.isTTY);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let received = 0;
  let nextLoggedQuarter = 1;
  let lastDraw = 0;
  const draw = (final: boolean) => {
    const line = `[fetch-data] ${label} ${formatProgressBar(received, final && !(total > 0) ? 0 : total)}`;
    if (isTty) {
      const now = Date.now();
      if (final || now - lastDraw > 80) {
        write(`\r${line}${final ? "\n" : ""}`);
        lastDraw = now;
      }
    } else if (final || (total > 0 && received / total >= nextLoggedQuarter / 4)) {
      write(`${line}\n`);
      while (total > 0 && received / total >= nextLoggedQuarter / 4) nextLoggedQuarter++;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (total > 0 && received > total) total = 0; // serwer podał zaniżony rozmiar – pokazujemy same MB
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Plik jest zbyt duży (ponad ${formatMegabytes(maxBytes)}).`);
    }
    chunks.push(value);
    if (received < total) draw(false);
  }
  draw(true);
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function stripMarks(value: string): string {
  return value.replace(/<\/?mark>/g, "");
}

/** Zestawienia „Wartość refundacji…” to statystyki kwot, a nie wykaz cen leków. */
export function isRefundValueTitle(rawTitle: string): boolean {
  return foldText(stripMarks(rawTitle)).includes("wartosc refundacji");
}

/**
 * Ocena trafności zbioru danych na podstawie tytułu (0 = zbiór odrzucony).
 * Wymaga słów o refundacji i lekach oraz „wykaz” lub „obwieszczenie” – dzięki temu
 * archiwalne zbiory statystyczne (np. NFZ „Leki refundowane”, 2018 r.) nie są brane pod uwagę.
 */
export function scoreDatasetTitle(rawTitle: string): number {
  const title = foldText(stripMarks(rawTitle));
  const hasRefund = title.includes("refund");
  const hasDrug = /\bleki?\b|\blekow\b|\bleku\b|lecznicz/.test(title);
  const isList = title.includes("wykaz") || title.includes("obwieszcz");
  if (!hasRefund || !hasDrug || !isList || isRefundValueTitle(title)) return 0;
  let score = 10;
  if (title.includes("wykaz")) score += 3;
  if (title.includes("obwieszcz")) score += 3;
  if (title.includes("minist")) score += 2;
  if (/wyrob|program|chemio|wartosc|liczba|budzet|realizacj/.test(title)) score -= 4;
  return Math.max(score, 0);
}

function kindFromUrl(url: string): SourceKind {
  return /\.xlsx(\?|#|$)/i.test(url) ? "xlsx" : "csv";
}

/** Data publikacji zasobu (z dokładnością do sekundy) z datą danych jako rozstrzygnięciem remisu. */
function publicationKey(resource: ApiResource): string {
  return `${resource.attributes.created ?? ""}|${resource.attributes.data_date ?? ""}`;
}

/**
 * Wybiera z listy zasobów zbioru pliki możliwe do przetworzenia – od najnowszej daty publikacji.
 * Pliki CSV i XLSX są pobierane w oryginale (XLSX konwertujemy sami, wybierając arkusz z tabelą
 * leków); dla innych formatów tabelarycznych używana jest konwersja CSV portalu dane.gov.pl.
 */
export function pickResources(resources: ApiResource[], datasetTitle: string): SourceCandidate[] {
  const sorted = [...resources].sort((a, b) => publicationKey(b).localeCompare(publicationKey(a)));
  const result: SourceCandidate[] = [];
  for (const resource of sorted) {
    const a = resource.attributes;
    if (isRefundValueTitle(a.title ?? "")) continue;
    const format = (a.format ?? "").toLowerCase();
    const title = stripMarks(`${datasetTitle} – ${a.title ?? `zasób ${resource.id}`}`);
    const published = publicationKey(resource);
    if (format === "csv" && a.download_url) {
      result.push({ url: a.download_url, kind: "csv", title, published });
    } else if (format === "xlsx" && a.download_url) {
      result.push({ url: a.download_url, kind: "xlsx", title, published });
    } else if (a.csv_download_url) {
      // dane.gov.pl udostępnia automatyczną konwersję plików tabelarycznych do CSV.
      result.push({ url: a.csv_download_url, kind: "csv", title, published });
    }
  }
  return result;
}

/**
 * @param download – pobieranie pliku: `Accept-Encoding: identity`, aby `Content-Length` był rozmiarem pliku
 *   (przy kompresji gzip byłby rozmiarem skompresowanym i pasek postępu pokazywałby np. „0.9 MB / 0.8 MB”).
 */
async function fetchWithTimeout(url: string, timeoutMs: number, accept: string, download = false): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: accept, "User-Agent": USER_AGENT, ...(download ? { "Accept-Encoding": "identity" } : {}) },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} dla ${url}`);
  }
  return response;
}

async function apiGet<T>(config: AppConfig, path: string): Promise<T> {
  const response = await fetchWithTimeout(`${config.daneGovApiBase}${path}`, config.fetchTimeoutMs, "application/json");
  const json = (await response.json()) as T;
  if (json === null || typeof json !== "object") throw new Error(`Nieprawidłowa odpowiedź API dla ${path}`);
  return json;
}

/**
 * Odpytuje katalog kolejno każdą frazą i zbiera pasujące zbiory (bez duplikatów, w kolejności fraz,
 * a w obrębie frazy – od najwyższej oceny tytułu). Błąd jednej frazy nie przerywa pozostałych.
 */
async function searchDatasets(config: AppConfig, log: (m: string) => void): Promise<{ id: string; title: string }[]> {
  const found = new Map<string, string>();
  const errors: string[] = [];
  for (const phrase of config.daneGovSearchQueries) {
    log(`Szukam zbioru danych w katalogu dane.gov.pl: „${phrase}”…`);
    let search: { data?: ApiDataset[] };
    try {
      search = await apiGet(config, `/datasets?q=${encodeURIComponent(phrase)}&per_page=50&sort=relevance`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`„${phrase}”: ${message}`);
      log(`  błąd wyszukiwania – ${message}`);
      continue;
    }
    const matches = (search.data ?? [])
      .map((d) => ({ id: d.id, title: stripMarks(d.attributes.title ?? "") }))
      .filter((d) => {
        if (!isRefundValueTitle(d.title)) return true;
        log(`  pomijam zbiór ${d.id} („Wartość refundacji”): ${d.title}`);
        return false;
      })
      .map((d) => ({ ...d, score: scoreDatasetTitle(d.title) }))
      .filter((d) => d.score > 0 && !found.has(d.id))
      .sort((a, b) => b.score - a.score);
    log(`  pasujące zbiory: ${matches.length}`);
    for (const d of matches) found.set(d.id, d.title);
  }
  if (found.size === 0) {
    const details = errors.length > 0 ? ` (${errors.join("; ")})` : "";
    throw new Error(`W katalogu nie znaleziono zbioru z wykazem refundowanych leków${details}.`);
  }
  return [...found].slice(0, 3).map(([id, title]) => ({ id, title }));
}

/** Ustala listę kandydatów do pobrania zgodnie z priorytetem opisanym w nagłówku pliku. */
export async function discoverCandidates(config: AppConfig, log: (m: string) => void): Promise<SourceCandidate[]> {
  if (config.sourceUrl) {
    log(`Używam źródła wskazanego w SOURCE_URL: ${config.sourceUrl}`);
    return [{ url: config.sourceUrl, kind: kindFromUrl(config.sourceUrl), title: "Źródło z SOURCE_URL" }];
  }

  let datasets: { id: string; title: string }[];
  if (config.daneGovDatasetId) {
    datasets = [{ id: config.daneGovDatasetId, title: `Zbiór ${config.daneGovDatasetId}` }];
  } else {
    datasets = await searchDatasets(config, log);
  }

  const candidates: SourceCandidate[] = [];
  for (const dataset of datasets) {
    log(`Zbiór ${dataset.id}: ${dataset.title}`);
    const resources = await apiGet<{ data?: ApiResource[] }>(
      config,
      `/datasets/${encodeURIComponent(dataset.id)}/resources?per_page=100&sort=-created`,
    );
    candidates.push(...pickResources(resources.data ?? [], dataset.title));
  }
  // Najnowsze publikacje najpierw – także między zbiorami (sortowanie stabilne).
  return candidates.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
}

/* -------------------------------------------------------------------------- */
/*  Źródło zapasowe: obwieszczenia MZ na gov.pl                               */
/* -------------------------------------------------------------------------- */

export interface HtmlLink {
  url: string;
  text: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/[​\s]+/g, " ")
    .trim();
}

/**
 * Wyciąga z listy obwieszczeń linki do pełnych obwieszczeń („Obwieszczenie Ministra Zdrowia z dnia …”)
 * w kolejności strony – najnowsze są na górze. Sprostowania i obwieszczenia „zmieniające” są pomijane,
 * bo ich załączniki zawierają tylko zmiany, a nie cały wykaz.
 */
export function parseObwieszczeniaList(html: string, baseUrl: string): HtmlLink[] {
  const result: HtmlLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeHtml(m[2] as string);
    const folded = foldText(text);
    if (!folded.startsWith("obwieszczenie ministra zdrowia z dnia")) continue;
    if (!folded.includes("wykazu refundowanych lekow")) continue;
    const url = new URL(decodeHtml(m[1] as string), baseUrl).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    result.push({ url, text });
  }
  return result;
}

/**
 * Wyszukuje na stronie obwieszczenia załącznik XLSX z wykazem („… zalacznik do obwieszczenia”, format xlsx).
 * Na gov.pl każdy plik to `<a class="file-download" href="/attachment/…" aria-label="Pobierz plik … Format: xlsx">`.
 */
export function findWykazXlsx(html: string, baseUrl: string): HtmlLink | null {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] as string;
    const href = /\bhref="([^"]+)"/i.exec(attrs)?.[1];
    if (!href) continue;
    const label = decodeHtml(`${/\baria-label="([^"]*)"/i.exec(attrs)?.[1] ?? ""} ${m[2] as string}`);
    const folded = foldText(label);
    const isXlsx = /format: ?xlsx\b/.test(folded) || /\.xlsx\b/.test(folded) || /\.xlsx(\?|$)/i.test(href);
    if (isXlsx && /zalacznik[ _]+do[ _]+obwieszczenia/.test(folded)) {
      // Treść linku: „84W zalacznik do obwieszczenia<br/><span class="extension">plik.xlsx</span>…”.
      const text = decodeHtml((m[2] as string).split(/<br\s*\/?>|<span\b/i)[0] as string);
      return { url: new URL(decodeHtml(href), baseUrl).toString(), text };
    }
  }
  return null;
}

async function fetchHtml(url: string, config: AppConfig): Promise<string> {
  const response = await fetchWithTimeout(url, config.fetchTimeoutMs, "text/html");
  return response.text();
}

/** Ustala adres załącznika XLSX z najnowszego obwieszczenia MZ (sprawdza do 3 najnowszych). */
export async function discoverGovPlCandidates(config: AppConfig, log: (m: string) => void): Promise<SourceCandidate[]> {
  const listUrl = config.mzObwieszczeniaUrl;
  if (listUrl === null) return [];
  log(`Szukam najnowszego obwieszczenia na ${listUrl}…`);
  const notices = parseObwieszczeniaList(await fetchHtml(listUrl, config), listUrl);
  if (notices.length === 0) throw new Error("Na stronie gov.pl nie znaleziono listy obwieszczeń.");
  for (const notice of notices.slice(0, 3)) {
    log(`Obwieszczenie: ${notice.text}`);
    const attachment = findWykazXlsx(await fetchHtml(notice.url, config), notice.url);
    if (attachment !== null) {
      return [{ url: attachment.url, kind: "xlsx", title: `${notice.text} – ${attachment.text}` }];
    }
    log("  brak załącznika XLSX z wykazem – sprawdzam starsze obwieszczenie.");
  }
  throw new Error("W najnowszych obwieszczeniach na gov.pl nie znaleziono załącznika XLSX z wykazem.");
}

/** Dekoduje tekst: UTF-8 (z usunięciem BOM), a gdy jest niepoprawny – Windows-1250. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1250").decode(bytes);
  }
}

/**
 * Pobiera zasób i zwraca ścieżkę do pliku CSV gotowego do wczytania przez DuckDB.
 * Zasób XLSX (rozpoznany po sygnaturze ZIP) jest konwertowany do CSV – z pierwszego arkusza
 * zawierającego tabelę leków.
 */
async function download(
  candidate: SourceCandidate,
  config: AppConfig,
  rawDir: string,
  log: (m: string) => void,
  progressWrite?: (chunk: string) => void,
): Promise<string> {
  const response = await fetchWithTimeout(candidate.url, config.fetchTimeoutMs * 4, "*/*", true);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`Plik jest zbyt duży (${declared} B).`);
  const bytes = await readWithProgress(response, "Wykaz MZ", { write: progressWrite });

  // Sygnatura ZIP („PK”) oznacza XLSX niezależnie od deklarowanego formatu.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  await mkdir(rawDir, { recursive: true });
  const csvPath = join(rawDir, "zrodlo.csv");
  if (!isZip) {
    await writeFile(csvPath, decodeText(bytes), "utf8");
    return csvPath;
  }
  const xlsxPath = join(rawDir, "zrodlo.xlsx");
  await writeFile(xlsxPath, bytes);
  const sheet = await convertXlsxToCsv(xlsxPath, csvPath);
  log(`Skonwertowano arkusz XLSX „${sheet}” do CSV.`);
  return csvPath;
}

export interface FetchOutcome {
  meta: DataMeta;
  /** True, gdy zbudowano bazę demo z próbki (brak wykazu MZ). */
  usedFallback: boolean;
  /** True, gdy wykaz MZ był niedostępny i zachowano leki Rp z istniejącego pliku Parquet. */
  reusedExisting?: boolean;
}

export interface FetchOtcOptions {
  log: (m: string) => void;
  /** Katalog na pliki tymczasowe. */
  rawDir: string;
  /** Data „dziś” (RRRR-MM-DD) do odrzucenia wygasłych pozwoleń – w testach stała. */
  today?: string;
  /** Wyjście paska postępu (domyślnie stdout). */
  progressWrite?: (chunk: string) => void;
}

/**
 * Etap OTC: pobiera eksport RPL, wybiera opakowania OTC i kody ATC, a następnie scala je z lekami Rp
 * zapisanymi w `config.dataFilePath`. Gdy RPL jest niedostępny lub ma nieoczekiwany format,
 * dołączany jest wbudowany zestaw popularnych leków OTC ({@link BUILTIN_OTC}).
 */
export async function addOtcDrugs(config: AppConfig, baseMeta: DataMeta, options: FetchOtcOptions): Promise<DataMeta> {
  const { log, rawDir } = options;
  const meta = {
    source: baseMeta.source,
    resource_url: baseMeta.resource_url,
    resource_title: baseMeta.resource_title,
  };
  if (config.rplCsvUrl !== null) {
    try {
      log(`Pobieram Rejestr Produktów Leczniczych (leki OTC i kody ATC): ${config.rplCsvUrl}`);
      const response = await fetchWithTimeout(config.rplCsvUrl, config.fetchTimeoutMs * 4, "text/csv,*/*", true);
      const bytes = await readWithProgress(response, "Rejestr RPL", { write: options.progressWrite });
      await mkdir(rawDir, { recursive: true });
      const csvPath = join(rawDir, "rpl.csv");
      await writeFile(csvPath, decodeText(bytes), "utf8");
      const products = await readRplCsv(csvPath);
      const today = options.today ?? new Date().toISOString().slice(0, 10);
      const extract = extractFromRpl(products, today);
      if (extract.otc.length === 0) throw new Error("eksport RPL nie zawiera opakowań z kategorią OTC");
      log(
        `RPL: ${products.length} produktów, ${extract.otc.length} opakowań OTC ` +
          `(pominięto ${extract.pominieteBezAtc} bez kodu ATC, głównie homeopatyczne – brak podstawy do szacunku ceny), ` +
          `${extract.atcByEan.size} kodów EAN z ATC.`,
      );
      const merged = await mergeCatalog({
        refundedParquet: config.dataFilePath,
        parquetPath: config.dataFilePath,
        otc: extract.otc,
        otcSource: "rpl",
        atcByEan: extract.atcByEan,
        meta,
      });
      await rm(rawDir, { recursive: true, force: true });
      return merged;
    } catch (error) {
      log(`Rejestr RPL niedostępny – ${error instanceof Error ? error.message : String(error)}`);
      await rm(rawDir, { recursive: true, force: true });
    }
  }
  log(`Dołączam wbudowany zestaw ${BUILTIN_OTC.length} popularnych leków bez recepty (OTC).`);
  return mergeCatalog({
    refundedParquet: config.dataFilePath,
    parquetPath: config.dataFilePath,
    otc: BUILTIN_OTC,
    otcSource: "builtin",
    meta,
  });
}

/**
 * Metadane istniejącego pliku Parquet z pełnym wykazem MZ (null, gdy pliku brak, jest uszkodzony
 * albo pochodzi z próbki demo) – podstawa do zachowania dotychczasowych leków Rp.
 */
async function existingRefundedData(config: AppConfig): Promise<DataMeta | null> {
  if (!existsSync(config.dataFilePath) || !(await isValidParquet(config.dataFilePath))) return null;
  try {
    const meta = JSON.parse(await readFile(metaPathFor(config.dataFilePath), "utf8")) as DataMeta;
    return meta.source === "parquet" ? meta : null;
  } catch {
    return null;
  }
}

export async function fetchData(
  config: AppConfig,
  options: {
    demoOnly?: boolean;
    log?: (m: string) => void;
    today?: string;
    /** Wyjście paska postępu pobierania (domyślnie stdout). */
    progressWrite?: (chunk: string) => void;
  } = {},
): Promise<FetchOutcome> {
  const log = options.log ?? ((m: string) => console.log(`[fetch-data] ${m}`));
  const rawDir = join(dirname(config.dataFilePath), "raw");
  const errors: string[] = [];
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const withOtc = async (base: DataMeta): Promise<DataMeta> => {
    const meta = await addOtcDrugs(config, base, {
      log,
      rawDir,
      today: options.today,
      progressWrite: options.progressWrite,
    });
    log(
      `Baza gotowa: ${meta.rows} pozycji (Rp: ${meta.rows_rp}, OTC: ${meta.rows_otc}, ` +
        `źródło OTC: ${meta.otc_source === "rpl" ? "Rejestr Produktów Leczniczych" : "wbudowany zestaw"}).`,
    );
    return meta;
  };

  /** Próbuje kolejnych kandydatów; zwraca wynik pierwszego poprawnego albo `null`. */
  const tryCandidates = async (candidates: SourceCandidate[]): Promise<FetchOutcome | null> => {
    for (const candidate of candidates.slice(0, MAX_ATTEMPTS)) {
      try {
        log(`Pobieram: ${candidate.title}`);
        const inputPath = await download(candidate, config, rawDir, log, options.progressWrite);
        const meta = await buildParquet({
          inputPath,
          kind: "csv",
          parquetPath: config.dataFilePath,
          minRows: config.sourceUrl ? 1 : MIN_ROWS_FROM_API,
          meta: { source: "parquet", resource_url: candidate.url, resource_title: candidate.title },
        });
        await rm(rawDir, { recursive: true, force: true });
        log(`Zapisano ${meta.rows} leków refundowanych do ${config.dataFilePath}.`);
        return { meta: await withOtc(meta), usedFallback: false };
      } catch (error) {
        errors.push(`${candidate.title}: ${errorMessage(error)}`);
        log(`Pominięto zasób – ${errorMessage(error)}`);
      }
    }
    return null;
  };

  if (!options.demoOnly) {
    let candidates: SourceCandidate[] = [];
    try {
      candidates = await discoverCandidates(config, log);
      if (candidates.length === 0) errors.push("Zbiór nie zawiera zasobów w formacie CSV/XLSX.");
    } catch (error) {
      errors.push(errorMessage(error));
    }
    const fromApi = await tryCandidates(candidates);
    if (fromApi !== null) return fromApi;

    // Brak wykazu w dane.gov.pl – sięgamy po załącznik XLSX najnowszego obwieszczenia na gov.pl.
    // Jawnie wskazany SOURCE_URL ma pierwszeństwo i nie jest zastępowany innym źródłem.
    if (config.sourceUrl === null && config.mzObwieszczeniaUrl !== null) {
      log("Brak wykazu w dane.gov.pl – pobieram załącznik z oficjalnej strony Ministerstwa Zdrowia.");
      try {
        const fromGovPl = await tryCandidates(await discoverGovPlCandidates(config, log));
        if (fromGovPl !== null) return fromGovPl;
      } catch (error) {
        errors.push(`gov.pl: ${errorMessage(error)}`);
      }
    }

    await rm(rawDir, { recursive: true, force: true });
    log("Nie udało się pobrać poprawnego wykazu (dane.gov.pl / gov.pl):");
    for (const e of errors) log(`  • ${e}`);

    // Istniejący pełny wykaz MZ jest cenniejszy niż próbka demo – zachowujemy dotychczasowe leki Rp.
    const existing = await existingRefundedData(config);
    if (existing !== null) {
      log(
        `Zachowuję dotychczasowe leki refundowane z ${config.dataFilePath} ` +
          `(${existing.rows_rp ?? existing.rows} pozycji Rp: ${existing.resource_title ?? "wykaz MZ"}).`,
      );
      return { meta: await withOtc(existing), usedFallback: false, reusedExisting: true };
    }
    log("Przełączam na tryb demo z próbki danych.");
  }

  const meta = await buildFromFallback(config.fallbackCsvPath, config.dataFilePath);
  log(
    `Zbudowano bazę demo: ${meta.rows} pozycji (Rp: ${meta.rows_rp}, OTC: ${meta.rows_otc}) → ${config.dataFilePath}.`,
  );
  return { meta, usedFallback: true };
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  try {
    const config = loadConfig();
    const outcome = await fetchData(config, { demoOnly: args.has("--demo") });
    if (outcome.usedFallback && args.has("--strict") && !args.has("--demo")) {
      console.error("[fetch-data] Tryb --strict: nie pobrano danych z API.");
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[config] ${error.message}`);
    } else {
      console.error("[fetch-data] Błąd krytyczny:", error);
    }
    process.exit(1);
  }
}
