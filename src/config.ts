/**
 * Konfiguracja aplikacji odczytywana wyłącznie ze zmiennych środowiskowych.
 *
 * Bun automatycznie wczytuje plik `.env`, więc lokalnie wystarczy skopiować
 * `.env.example` do `.env`. Każda wartość jest walidowana przy starcie –
 * błędna konfiguracja kończy proces czytelnym komunikatem zamiast
 * trudnego do zdiagnozowania błędu w trakcie działania.
 */
import { isAbsolute, resolve } from "node:path";

export type NodeEnv = "development" | "production" | "test";

export interface AppConfig {
  /** Port HTTP serwera (0 = losowy wolny port, używane w testach). */
  readonly port: number;
  readonly nodeEnv: NodeEnv;
  /** Ścieżka bezwzględna do pliku Parquet z wykazem leków. */
  readonly dataFilePath: string;
  /** Ścieżka bezwzględna do próbki CSV używanej w trybie awaryjnym / demo. */
  readonly fallbackCsvPath: string;
  /** Bazowy adres API dane.gov.pl (bez końcowego ukośnika). */
  readonly daneGovApiBase: string;
  /** Frazy wyszukiwania zbioru danych w katalogu dane.gov.pl (odpytywane kolejno). */
  readonly daneGovSearchQueries: readonly string[];
  /** Opcjonalny, jawnie wskazany identyfikator zbioru danych na dane.gov.pl. */
  readonly daneGovDatasetId: string | null;
  /** Opcjonalny bezpośredni adres pliku CSV/XLSX (pomija wyszukiwanie w katalogu). */
  readonly sourceUrl: string | null;
  /**
   * Strona gov.pl z listą obwieszczeń MZ – źródło zapasowe, gdy w dane.gov.pl brak wykazu
   * (`null` = wyłączone, gdy zmienna ustawiona na „off”).
   */
  readonly mzObwieszczeniaUrl: string | null;
  /** Limit czasu pojedynczego żądania sieciowego skryptu pobierającego (ms). */
  readonly fetchTimeoutMs: number;
  /** Domyślna liczba wyników wyszukiwania. */
  readonly searchDefaultLimit: number;
  /** Maksymalna liczba wyników wyszukiwania, jaką może zażądać klient. */
  readonly searchMaxLimit: number;
  /** Czas cache odpowiedzi API (sekundy) w nagłówku Cache-Control. */
  readonly apiCacheMaxAge: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const NODE_ENVS: readonly NodeEnv[] = ["development", "production", "test"];

/**
 * Domyślne frazy wyszukiwania wykazu Ministerstwa Zdrowia. Ogólna fraza „leki refundowane”
 * trafiała na archiwalny zbiór statystyczny NFZ (id 1106, 2018 r.).
 */
export const DEFAULT_SEARCH_QUERIES: readonly string[] = Object.freeze([
  "wykaz refundowanych leków",
  "obwieszczenie Ministra Zdrowia w sprawie wykazu refundowanych leków",
]);

/** Oficjalna lista obwieszczeń Ministra Zdrowia w sprawie wykazu leków refundowanych. */
export const DEFAULT_MZ_OBWIESZCZENIA_URL =
  "https://www.gov.pl/web/zdrowie/obwieszczenia-ministra-zdrowia-lista-lekow-refundowanych";

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === "" ? fallback : value;
}

function readOptional(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** Lista wartości rozdzielonych znakiem „|” (np. kilka fraz wyszukiwania). */
function readList(env: Env, key: string, fallback: readonly string[]): readonly string[] {
  const values = (env[key] ?? "")
    .split("|")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return Object.freeze(values.length > 0 ? values : [...fallback]);
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(`${key} musi być liczbą całkowitą, otrzymano "${raw}".`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(`${key} musi mieścić się w zakresie ${min}–${max}, otrzymano ${value}.`);
  }
  return value;
}

function readUrl(env: Env, key: string, fallback: string | null): string | null {
  const raw = readOptional(env, key) ?? fallback;
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${key} nie jest poprawnym adresem URL: "${raw}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${key} musi używać protokołu http(s), otrzymano "${url.protocol}".`);
  }
  return raw.replace(/\/+$/, "");
}

function readPath(env: Env, key: string, fallback: string, cwd: string): string {
  const value = readString(env, key, fallback);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/**
 * Buduje i waliduje konfigurację. Przyjmuje obiekt środowiska jako parametr,
 * dzięki czemu jest w pełni testowalna bez modyfikowania `process.env`.
 */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): AppConfig {
  const nodeEnvRaw = readString(env, "NODE_ENV", "development");
  if (!NODE_ENVS.includes(nodeEnvRaw as NodeEnv)) {
    throw new ConfigError(`NODE_ENV musi być jedną z wartości: ${NODE_ENVS.join(", ")}; otrzymano "${nodeEnvRaw}".`);
  }

  const datasetId = readOptional(env, "DANE_GOV_DATASET_ID");
  if (datasetId !== null && !/^\d+$/.test(datasetId)) {
    throw new ConfigError(`DANE_GOV_DATASET_ID musi być liczbowym identyfikatorem zbioru, otrzymano "${datasetId}".`);
  }

  const searchMaxLimit = readInt(env, "SEARCH_MAX_LIMIT", 50, 1, 500);
  const searchDefaultLimit = readInt(env, "SEARCH_DEFAULT_LIMIT", 20, 1, 500);
  if (searchDefaultLimit > searchMaxLimit) {
    throw new ConfigError("SEARCH_DEFAULT_LIMIT nie może być większy niż SEARCH_MAX_LIMIT.");
  }

  const config: AppConfig = {
    port: readInt(env, "PORT", 3000, 0, 65535),
    nodeEnv: nodeEnvRaw as NodeEnv,
    dataFilePath: readPath(env, "DATA_FILE_PATH", "./data/leki.parquet", cwd),
    fallbackCsvPath: readPath(env, "FALLBACK_CSV_PATH", "./tests/fixtures/sample_leki.csv", cwd),
    daneGovApiBase: readUrl(env, "DANE_GOV_API_BASE", "https://api.dane.gov.pl/1.4") as string,
    daneGovSearchQueries: readList(env, "DANE_GOV_SEARCH_QUERY", DEFAULT_SEARCH_QUERIES),
    daneGovDatasetId: datasetId,
    sourceUrl: readUrl(env, "SOURCE_URL", null),
    mzObwieszczeniaUrl:
      readOptional(env, "MZ_OBWIESZCZENIA_URL")?.toLowerCase() === "off"
        ? null
        : readUrl(env, "MZ_OBWIESZCZENIA_URL", DEFAULT_MZ_OBWIESZCZENIA_URL),
    fetchTimeoutMs: readInt(env, "FETCH_TIMEOUT_MS", 30_000, 1_000, 600_000),
    searchDefaultLimit,
    searchMaxLimit,
    apiCacheMaxAge: readInt(env, "API_CACHE_MAX_AGE", 60, 0, 86_400),
  };

  return Object.freeze(config);
}
