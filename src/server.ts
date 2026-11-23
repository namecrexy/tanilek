/**
 * Serwer HTTP TaniLek oparty na natywnym `Bun.serve()`.
 *
 * Endpointy:
 *   GET /api/health                 – stan aplikacji i źródła danych
 *   GET /api/search?q=...&limit=...&kategoria=wszystkie|Rp|OTC
 *                                   – wyszukiwanie leków (cache LRU/TTL 10 min; pola `cached`, `durationMs`,
 *                                     liczniki kategorii `liczniki` oraz `sredniaCena` grupy przy każdym leku)
 *   GET /api/equivalents?id=...     – zamienniki wybranego leku z wyliczeniem oszczędności,
 *                                     wskazaniem refundacyjnym MZ (`wskazanie`) oraz opisem
 *                                     substancji „na co pomaga i jak stosować” (`opisSubstancji`)
 *   GET /api/pharmacies?q=...       – najbliższe apteki dla kodu pocztowego lub adresu (OpenStreetMap,
 *                                     3 serwery Overpass z failoverem, tryb awaryjny `isFallback`)
 *   GET /, /styles.css, /app.js     – interfejs użytkownika (pliki statyczne z pamięci, `no-cache`
 *                                     + walidacja ETag, więc F5 zawsze pobiera najnowszą wersję)
 *
 * Każda odpowiedź API zawiera nagłówek `Server-Timing` z czasem zapytania DuckDB
 * oraz `ETag`/`Cache-Control` umożliwiające odpowiedzi 304 Not Modified.
 */
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { TtlLruCache } from "./cache";
import { type AppConfig, ConfigError, loadConfig } from "./config";
import { CATEGORY_FILTERS, DrugDatabase } from "./db";
import { findNearbyPharmacies, PharmacyLookupError } from "./pharmacies";
import type { HealthStatus, KategoriaFiltr, SearchResponse, SearchResult } from "./types";

export const APP_VERSION: string = packageJson.version;

const PUBLIC_DIR = join(import.meta.dir, "public");

/** Czas życia wpisu cache wyszukiwania (10 minut). */
export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
/** Maksymalna liczba zapamiętanych zapytań wyszukiwania. */
export const SEARCH_CACHE_MAX_ENTRIES = 1000;

const STATIC_FILES: Readonly<Record<string, { file: string; type: string; cache: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8", cache: "no-cache" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8", cache: "no-cache" },
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

interface StaticAsset {
  body: Uint8Array<ArrayBuffer>;
  etag: string;
  type: string;
  cache: string;
}

/** Wczytuje pliki interfejsu do pamięci jednorazowo przy starcie – zero I/O dysku na żądanie. */
async function loadStaticAssets(): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  for (const [route, def] of Object.entries(STATIC_FILES)) {
    const body = new Uint8Array(await Bun.file(join(PUBLIC_DIR, def.file)).arrayBuffer());
    assets.set(route, { body, etag: makeEtag(body), type: def.type, cache: def.cache });
  }
  return assets;
}

export function makeEtag(body: string | Uint8Array): string {
  return `"${Bun.hash(body).toString(36)}"`;
}

/** Formatuje nagłówek Server-Timing (czasy w ms z dokładnością do mikrosekund). */
export function serverTiming(dbMs: number | null, totalMs: number): string {
  const parts: string[] = [];
  if (dbMs !== null) parts.push(`db;dur=${dbMs.toFixed(3)};desc="DuckDB query"`);
  parts.push(`total;dur=${totalMs.toFixed(3)};desc="Request total"`);
  return parts.join(", ");
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag || t === "*");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiPayload {
  body: unknown;
  dbMs: number | null;
  cacheable: boolean;
  /**
   * Treść, z której liczony jest ETag – bez pól zmiennych przy każdym żądaniu (`cached`, `durationMs`),
   * aby przeglądarka dostawała 304 Not Modified dla niezmienionych wyników.
   */
  etagSource?: unknown;
}

/** Usuwa pola diagnostyczne zmieniające się przy każdym żądaniu (do wyliczenia ETag). */
function stableBody(body: object): object {
  const { cached: _cached, durationMs: _durationMs, ...rest } = body as Record<string, unknown>;
  return rest;
}

export interface CreateServerOptions {
  config: AppConfig;
  db: DrugDatabase;
  /** Nadpisanie portu (np. 0 w testach). */
  port?: number;
  hostname?: string;
  /** Implementacja `fetch` dla zapytań do OpenStreetMap (mock w testach). */
  pharmacyFetch?: typeof fetch;
  /** False – błąd 502 zamiast przykładowych aptek przy awarii wszystkich serwerów Overpass (domyślnie true). */
  pharmacyFallback?: boolean;
  /** Źródło czasu cache wyszukiwania (do testów wygasania). */
  now?: () => number;
}

/** Kontekst żądania API: konfiguracja serwera i jego pamięć podręczna wyszukiwania. */
interface ApiContext {
  options: CreateServerOptions;
  startedAt: number;
  searchCache: TtlLruCache<string, SearchResult>;
}

function parseCategory(raw: string | null): KategoriaFiltr {
  if (raw === null || raw === "") return "wszystkie";
  const value = raw.trim();
  const match = CATEGORY_FILTERS.find((c) => c.toLowerCase() === value.toLowerCase());
  if (!match) throw new HttpError(400, "Parametr 'kategoria' musi mieć wartość: wszystkie, Rp lub OTC.");
  return match;
}

/** Klucz cache wyszukiwania: znormalizowana fraza, limit i filtr kategorii. */
export function searchCacheKey(q: string, limit: number, kategoria: KategoriaFiltr): string {
  return `${q.trim().toLocaleLowerCase("pl").replace(/\s+/g, " ")}|${limit}|${kategoria}`;
}

function parseLimit(raw: string | null, config: AppConfig): number {
  if (raw === null || raw === "") return config.searchDefaultLimit;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "Parametr 'limit' musi być dodatnią liczbą całkowitą.");
  const value = Number(raw);
  if (value < 1 || value > config.searchMaxLimit) {
    throw new HttpError(400, `Parametr 'limit' musi mieścić się w zakresie 1–${config.searchMaxLimit}.`);
  }
  return value;
}

async function handleApi(url: URL, ctx: ApiContext): Promise<ApiPayload> {
  const { options, startedAt } = ctx;
  const { db, config } = options;
  switch (url.pathname) {
    case "/api/health": {
      const body: HealthStatus = {
        status: "ok",
        version: APP_VERSION,
        rows: db.rowCount,
        data: db.meta,
        uptime_s: Math.round((performance.now() - startedAt) / 1000),
        search_max_limit: config.searchMaxLimit,
      };
      return { body, dbMs: null, cacheable: false };
    }
    case "/api/search": {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 2) throw new HttpError(400, "Parametr 'q' musi mieć co najmniej 2 znaki.");
      if (q.length > 100) throw new HttpError(400, "Parametr 'q' może mieć maksymalnie 100 znaków.");
      const limit = parseLimit(url.searchParams.get("limit"), config);
      const kategoria = parseCategory(url.searchParams.get("kategoria"));
      const t0 = performance.now();
      const key = searchCacheKey(q, limit, kategoria);
      const hit = ctx.searchCache.get(key);
      const elapsed = () => Math.round((performance.now() - t0) * 1000) / 1000;
      if (hit) {
        const body: SearchResponse = { ...hit, cached: true, durationMs: elapsed() };
        return { body, dbMs: 0, cacheable: true, etagSource: hit };
      }
      const { data, durationMs } = await db.search(q, limit, kategoria);
      ctx.searchCache.set(key, data);
      const body: SearchResponse = { ...data, cached: false, durationMs: elapsed() };
      return { body, dbMs: durationMs, cacheable: true, etagSource: data };
    }
    case "/api/equivalents": {
      const rawId = url.searchParams.get("id") ?? "";
      if (!/^\d{1,9}$/.test(rawId) || Number(rawId) < 1) {
        throw new HttpError(400, "Parametr 'id' musi być dodatnią liczbą całkowitą.");
      }
      const { data, durationMs } = await db.equivalents(Number(rawId));
      if (data === null) throw new HttpError(404, `Nie znaleziono leku o id=${rawId}.`);
      return { body: data, dbMs: durationMs, cacheable: true };
    }
    case "/api/pharmacies": {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 3) throw new HttpError(400, "Parametr 'q' musi mieć co najmniej 3 znaki.");
      if (q.length > 120) throw new HttpError(400, "Parametr 'q' może mieć maksymalnie 120 znaków.");
      try {
        const body = await findNearbyPharmacies(q, {
          fetchFn: options.pharmacyFetch,
          fallbackOnOverpassError: options.pharmacyFallback !== false,
        });
        // Tryb awaryjny nie jest cache'owany przez przeglądarkę – kolejna próba ma odpytać OSM ponownie.
        return { body, dbMs: null, cacheable: !body.isFallback, etagSource: stableBody(body) };
      } catch (error) {
        if (error instanceof PharmacyLookupError) {
          if (error.status === 502) {
            const cause = error.cause instanceof Error ? error.cause.message : error.message;
            console.warn(`[apteki] Błąd OpenStreetMap: ${cause}`);
          }
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
    }
    default:
      throw new HttpError(404, "Nieznany endpoint API.");
  }
}

/** Tworzy i uruchamia serwer HTTP. Zwraca instancję `Bun.Server` (do zatrzymania w testach). */
export async function createServer(options: CreateServerOptions) {
  const assets = await loadStaticAssets();
  const startedAt = performance.now();
  const { config } = options;
  const ctx: ApiContext = {
    options,
    startedAt,
    searchCache: new TtlLruCache<string, SearchResult>({
      maxEntries: SEARCH_CACHE_MAX_ENTRIES,
      ttlMs: SEARCH_CACHE_TTL_MS,
      now: options.now,
    }),
  };

  const respond = (
    req: Request,
    status: number,
    body: string | Uint8Array<ArrayBuffer>,
    headers: Record<string, string>,
    etag: string | null,
  ): Response => {
    const finalHeaders: Record<string, string> = { ...SECURITY_HEADERS, ...headers };
    if (etag) {
      finalHeaders.ETag = etag;
      if (status === 200 && etagMatches(req.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers: finalHeaders });
      }
    }
    return new Response(req.method === "HEAD" ? null : body, { status, headers: finalHeaders });
  };

  return Bun.serve({
    port: options.port ?? config.port,
    hostname: options.hostname ?? "0.0.0.0",
    development: false,
    // Overpass: do 3 serwerów × 8 s × 2 promienie + geokodowanie (10 s) – domyślne 10 s zrywałoby
    // połączenie przed odpowiedzią `/api/pharmacies`.
    idleTimeout: 120,
    async fetch(req) {
      const t0 = performance.now();
      const url = new URL(req.url);

      if (req.method !== "GET" && req.method !== "HEAD") {
        return respond(
          req,
          405,
          JSON.stringify({ error: "Metoda niedozwolona." }),
          { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" },
          null,
        );
      }

      if (url.pathname.startsWith("/api/")) {
        try {
          const payload = await handleApi(url, ctx);
          const json = JSON.stringify(payload.body);
          return respond(
            req,
            200,
            json,
            {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": payload.cacheable ? `public, max-age=${config.apiCacheMaxAge}` : "no-store",
              "Server-Timing": serverTiming(payload.dbMs, performance.now() - t0),
            },
            payload.cacheable
              ? makeEtag(payload.etagSource === undefined ? json : JSON.stringify(payload.etagSource))
              : null,
          );
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500;
          const message = error instanceof HttpError ? error.message : "Wewnętrzny błąd serwera.";
          if (status === 500) console.error("[api] Nieobsłużony błąd:", error);
          return respond(
            req,
            status,
            JSON.stringify({ error: message }),
            {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "Server-Timing": serverTiming(null, performance.now() - t0),
            },
            null,
          );
        }
      }

      const asset = assets.get(url.pathname);
      if (asset) {
        return respond(
          req,
          200,
          asset.body,
          {
            "Content-Type": asset.type,
            "Cache-Control": asset.cache,
            "Server-Timing": serverTiming(null, performance.now() - t0),
          },
          asset.etag,
        );
      }

      return respond(
        req,
        404,
        "Nie znaleziono strony.",
        { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        null,
      );
    },
    error(error) {
      console.error("[server] Błąd krytyczny:", error);
      return new Response("Wewnętrzny błąd serwera.", { status: 500 });
    },
  });
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[config] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const db = await DrugDatabase.open({
    dataFilePath: config.dataFilePath,
    fallbackCsvPath: config.fallbackCsvPath,
    log: (m) => console.log(`[dane] ${m}`),
  });
  const server = await createServer({ config, db });

  const sourceLabel = db.source === "fallback-demo" ? "TRYB DEMO (próbka danych)" : "pełny wykaz z dane.gov.pl";
  console.log(`[server] TaniLek ${APP_VERSION} działa na http://localhost:${server.port}`);
  console.log(
    `[server] Wczytano ${db.rowCount} pozycji (Rp: ${db.meta.rows_rp ?? "?"}, OTC: ${db.meta.rows_otc ?? 0}) – ${sourceLabel}.`,
  );

  const shutdown = (signal: string) => {
    console.log(`[server] Otrzymano ${signal}, zamykanie...`);
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
