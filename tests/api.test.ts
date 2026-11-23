import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import { DrugDatabase } from "../src/db";
import { BUILTIN_OTC } from "../src/otc";
import { APP_VERSION, createServer, makeEtag, searchCacheKey, serverTiming } from "../src/server";
import type { EquivalentsResult, HealthStatus, SearchResponse, SearchResult } from "../src/types";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");

let workDir: string;
let db: DrugDatabase;
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tanilek-api-"));
  const config = loadConfig(
    {
      NODE_ENV: "test",
      PORT: "0",
      DATA_FILE_PATH: join(workDir, "leki.parquet"),
      FALLBACK_CSV_PATH: FIXTURE,
      API_CACHE_MAX_AGE: "60",
    },
    workDir,
  );
  db = await DrugDatabase.open({ dataFilePath: config.dataFilePath, fallbackCsvPath: config.fallbackCsvPath });
  server = await createServer({ config, db, port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  db.close();
  await rm(workDir, { recursive: true, force: true });
});

function timingOf(res: Response): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (res.headers.get("server-timing") ?? "").split(",")) {
    const match = /^\s*(\w+);dur=([\d.]+)/.exec(part);
    if (match?.[1] && match[2]) out[match[1]] = Number(match[2]);
  }
  return out;
}

describe("GET /api/health", () => {
  test("zwraca stan aplikacji i źródło danych", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as HealthStatus;
    expect(body.status).toBe("ok");
    expect(body.version).toBe(APP_VERSION);
    expect(body.rows).toBe(35 + BUILTIN_OTC.length);
    expect(body.data.rows_rp).toBe(35);
    expect(body.data.rows_otc).toBe(BUILTIN_OTC.length);
    expect(body.data.source).toBe("fallback-demo");
  });
});

describe("GET /api/search", () => {
  test("zwraca wyniki z nagłówkami Server-Timing, ETag i Cache-Control", async () => {
    const res = await fetch(`${base}/api/search?q=sortis`);
    expect(res.status).toBe(200);
    const timing = timingOf(res);
    expect(timing.db).toBeGreaterThan(0);
    expect(timing.total).toBeGreaterThanOrEqual(timing.db ?? 0);
    expect(res.headers.get("server-timing")).toContain('desc="DuckDB query"');
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-z]+"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as SearchResult;
    expect(body.count).toBe(5); // Sortis + zamienniki z atorwastatyną (alias „sortis”)
    expect(body.items[0]?.nazwa).toBe("Sortis");
    expect(body.items[0]?.dopasowanie).toBe("nazwa");
    expect(Object.keys(body.items[0] ?? {}).some((k) => k.startsWith("_"))).toBe(false);
    expect(body.items[0]?.mozliwa_oszczednosc).toBe(82.4);
  });

  test("odpowiada 304 Not Modified dla zgodnego If-None-Match", async () => {
    const first = await fetch(`${base}/api/search?q=metformin`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();
    const second = await fetch(`${base}/api/search?q=metformin`, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("server-timing")).toContain("db;dur=");
    expect(await second.text()).toBe("");
  });

  test("obsługuje parametr limit", async () => {
    const res = await fetch(`${base}/api/search?q=nadcisnienie&limit=2`);
    const body = (await res.json()) as SearchResult;
    expect(body.count).toBe(2);
  });

  test("zwraca resolvedNote dla polskiej nazwy substancji i literówki", async () => {
    const alias = (await (await fetch(`${base}/api/search?q=atorwastatyna`)).json()) as SearchResult;
    expect(alias.matchMode).toBe("alias");
    expect(alias.resolvedNote).toContain("Atorvastatinum");
    const fuzzy = (await (await fetch(`${base}/api/search?q=glucofage`)).json()) as SearchResult;
    expect(fuzzy.matchMode).toBe("fuzzy");
    expect(fuzzy.resolvedNote).toBe("Pokazuję najbardziej zbliżone wyniki dla: glucofage");
  });

  test.each([
    ["za krótkie zapytanie", "q=a"],
    ["brak zapytania", ""],
    ["za długie zapytanie", `q=${"x".repeat(101)}`],
    ["limit nie jest liczbą", "q=sortis&limit=abc"],
    ["limit równy zero", "q=sortis&limit=0"],
    ["limit powyżej maksimum", "q=sortis&limit=501"],
  ])("400 – %s", async (_name, query) => {
    const res = await fetch(`${base}/api/search?${query}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe("GET /api/equivalents", () => {
  test("zwraca zamienniki z oszczędnością w PLN i %", async () => {
    const res = await fetch(`${base}/api/equivalents?id=1`);
    expect(res.status).toBe(200);
    expect(timingOf(res).db).toBeGreaterThan(0);
    const body = (await res.json()) as EquivalentsResult;
    expect(body.wybrany.nazwa).toBe("Sortis");
    expect(body.zamienniki).toHaveLength(5);
    expect(body.zamienniki[0]?.lek.nazwa).toBe("Atorvastatin Teva");
    expect(body.najlepsza_oferta?.oszczednosc_pln).toBe(82.4);
    expect(body.najlepsza_oferta?.oszczednosc_proc).toBe(96.9);
  });

  test("zwraca wskazanie refundacyjne i opis substancji (na co pomaga, jak stosować)", async () => {
    const body = (await (await fetch(`${base}/api/equivalents?id=1`)).json()) as EquivalentsResult;
    expect(body.wskazanie).toBe("Hipercholesterolemia, profilaktyka chorób sercowo-naczyniowych");
    expect(body.wybrany.wskazanie).toBe(body.wskazanie);
    expect(body.opisSubstancji.zrodlo).toBe("slownik");
    expect(body.opisSubstancji.substancja).toBe("Atorvastatinum");
    expect(body.opisSubstancji.kategoria).toBe("Lek obniżający cholesterol (statyna)");
    expect(body.opisSubstancji.naCoPomaga).toContain("cholesterol");
    expect(body.opisSubstancji.jakStosowac.length).toBeGreaterThan(20);
  });

  test("dopasowuje opis do odmiany nazwy substancji z obwieszczenia (Metformini hydrochloridum)", async () => {
    const body = (await (await fetch(`${base}/api/equivalents?id=6`)).json()) as EquivalentsResult;
    expect(body.opisSubstancji.substancja).toBe("Metforminum");
    expect(body.opisSubstancji.kategoria).toContain("przeciwcukrzycowy");
    expect(body.wskazanie).toBe("Cukrzyca typu 2");
  });

  test("404 dla nieistniejącego leku", async () => {
    const res = await fetch(`${base}/api/equivalents?id=99999`);
    expect(res.status).toBe(404);
  });

  test.each(["", "abc", "0", "-1", "1.5", "1234567890"])("400 dla id=%p", async (id) => {
    const res = await fetch(`${base}/api/equivalents?id=${encodeURIComponent(id)}`);
    expect(res.status).toBe(400);
  });
});

describe("routing i nagłówki", () => {
  test("serwuje interfejs z nagłówkami bezpieczeństwa", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const html = await res.text();
    expect(html).toContain("TaniLek");
    expect(APP_VERSION).toBe("1.2.0");
    expect(html).toContain(`src="/app.js?v=${APP_VERSION}"`);
    expect(html).toContain(`href="/styles.css?v=${APP_VERSION}"`);
    expect(html).toContain("Znajdź aptekę w pobliżu");
  });

  test.each([
    ["/app.js", "text/javascript"],
    ["/styles.css", "text/css"],
  ])("serwuje %s z Cache-Control: no-cache i ETag", async (path, type) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const etag = res.headers.get("etag") ?? "";
    await res.arrayBuffer();
    const cached = await fetch(`${base}${path}`, { headers: { "If-None-Match": `W/${etag}` } });
    expect(cached.status).toBe(304);
  });

  test("HEAD zwraca nagłówki bez treści", async () => {
    const res = await fetch(`${base}/api/search?q=sortis`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toContain("db;dur=");
    expect(await res.text()).toBe("");
  });

  test("405 dla metod innych niż GET/HEAD", async () => {
    const res = await fetch(`${base}/api/search?q=sortis`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test("404 dla nieznanego endpointu API i strony", async () => {
    expect((await fetch(`${base}/api/nieznany`)).status).toBe(404);
    expect((await fetch(`${base}/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
  });
});

describe("funkcje pomocnicze serwera", () => {
  test("serverTiming formatuje czasy z dokładnością do mikrosekund", () => {
    expect(serverTiming(0.41234, 1.5)).toBe('db;dur=0.412;desc="DuckDB query", total;dur=1.500;desc="Request total"');
    expect(serverTiming(null, 2)).toBe('total;dur=2.000;desc="Request total"');
  });

  test("makeEtag jest deterministyczny", () => {
    expect(makeEtag("abc")).toBe(makeEtag("abc"));
    expect(makeEtag("abc")).not.toBe(makeEtag("abd"));
  });
});

describe("loadConfig", () => {
  test("ustawia bezpieczne wartości domyślne", () => {
    const config = loadConfig({}, "/app");
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe("development");
    expect(config.daneGovApiBase).toBe("https://api.dane.gov.pl/1.4");
    expect(config.dataFilePath).toBe(resolve("/app", "data/leki.parquet"));
    expect(config.sourceUrl).toBeNull();
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("odczytuje i normalizuje wartości ze środowiska", () => {
    const config = loadConfig(
      {
        PORT: "8080",
        NODE_ENV: "production",
        DANE_GOV_API_BASE: "https://api.example.test/1.4/",
        DANE_GOV_DATASET_ID: "1106",
        SOURCE_URL: "https://example.test/wykaz.xlsx",
      },
      "/app",
    );
    expect(config.port).toBe(8080);
    expect(config.daneGovApiBase).toBe("https://api.example.test/1.4");
    expect(config.daneGovDatasetId).toBe("1106");
    expect(config.sourceUrl).toBe("https://example.test/wykaz.xlsx");
  });

  test.each([
    [{ PORT: "abc" }],
    [{ PORT: "70000" }],
    [{ NODE_ENV: "staging" }],
    [{ DANE_GOV_API_BASE: "nie-url" }],
    [{ DANE_GOV_API_BASE: "ftp://dane.gov.pl" }],
    [{ DANE_GOV_DATASET_ID: "12a" }],
    [{ SEARCH_DEFAULT_LIMIT: "60", SEARCH_MAX_LIMIT: "50" }],
    [{ FETCH_TIMEOUT_MS: "10" }],
  ])("odrzuca błędną konfigurację %p", (env) => {
    expect(() => loadConfig(env as Record<string, string>, "/app")).toThrow(ConfigError);
  });
});

describe("GET /api/search – cache, kategorie i średnia cena (v1.2.0)", () => {
  test("pierwsze zapytanie „na żywo”, powtórzone – z pamięci podręcznej (cached, durationMs)", async () => {
    const first = (await (await fetch(`${base}/api/search?q=Tulip`)).json()) as SearchResponse;
    expect(first.cached).toBe(false);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    const second = (await (await fetch(`${base}/api/search?q=%20tulip%20`)).json()) as SearchResponse;
    expect(second.cached).toBe(true);
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.items).toEqual(first.items);
  });

  test("klucz cache uwzględnia limit i kategorię", async () => {
    const a = (await (await fetch(`${base}/api/search?q=Crestor&limit=5`)).json()) as SearchResponse;
    const b = (await (await fetch(`${base}/api/search?q=Crestor&limit=6`)).json()) as SearchResponse;
    const c = (await (await fetch(`${base}/api/search?q=Crestor&limit=5&kategoria=Rp`)).json()) as SearchResponse;
    expect([a.cached, b.cached, c.cached]).toEqual([false, false, false]);
    expect(searchCacheKey(" Crestor ", 5, "Rp")).toBe("crestor|5|Rp");
  });

  test("ETag nie zależy od pól cached/durationMs – 304 także dla odpowiedzi z cache", async () => {
    const first = await fetch(`${base}/api/search?q=Plavix`);
    const etag = first.headers.get("etag") ?? "";
    expect(((await first.json()) as SearchResponse).cached).toBe(false);
    const cachedRes = await fetch(`${base}/api/search?q=Plavix`);
    expect(cachedRes.headers.get("etag")).toBe(etag);
    expect(((await cachedRes.json()) as SearchResponse).cached).toBe(true);
    const notModified = await fetch(`${base}/api/search?q=Plavix`, { headers: { "If-None-Match": etag } });
    expect(notModified.status).toBe(304);
  });

  test("kategoria=OTC i kategoria=Rp filtrują wyniki, liczniki obejmują obie kategorie", async () => {
    const all = (await (await fetch(`${base}/api/search?q=um&limit=50`)).json()) as SearchResponse;
    const otc = (await (await fetch(`${base}/api/search?q=um&limit=50&kategoria=OTC`)).json()) as SearchResponse;
    const rp = (await (await fetch(`${base}/api/search?q=um&limit=50&kategoria=rp`)).json()) as SearchResponse;
    expect(all.kategoria).toBe("wszystkie");
    expect(otc.kategoria).toBe("OTC");
    expect(rp.kategoria).toBe("Rp");
    expect(otc.items.length).toBeGreaterThan(0);
    expect(otc.items.every((i) => i.kategoriaDostepnosci === "OTC")).toBe(true);
    expect(rp.items.every((i) => i.kategoriaDostepnosci === "Rp" && i.czyRefundowany)).toBe(true);
    expect(otc.liczniki).toEqual(all.liczniki as NonNullable<typeof all.liczniki>);
    expect(all.liczniki?.Rp).toBeGreaterThan(0);
    expect(all.liczniki?.OTC).toBe(otc.count);
    expect(all.liczniki?.Rp).toBe(rp.count);
  });

  test("400 dla nieznanej kategorii", async () => {
    const res = await fetch(`${base}/api/search?q=apap&kategoria=Rpw`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("'kategoria'");
  });

  test("wyniki i zamienniki zawierają średnią cenę w grupie", async () => {
    const search = (await (await fetch(`${base}/api/search?q=Atoris`)).json()) as SearchResponse;
    const hit = search.items[0];
    expect(hit?.sredniaCena).toBeGreaterThan(0);
    expect(hit?.liczbaWGrupie).toBe(5);
    const eq = (await (await fetch(`${base}/api/equivalents?id=${hit?.id}`)).json()) as EquivalentsResult;
    expect(eq.liczbaWGrupie).toBe(5);
    expect(eq.sredniaCena).toBeCloseTo(hit?.sredniaCena ?? 0, 2);
    expect(eq.roznicaDoSredniej).toBeLessThan(0); // Atoris (3,20 zł) jest tańszy od średniej w grupie
  });

  test("lek OTC w panelu zamienników ma kategorię OTC i opis ze słownika", async () => {
    const search = (await (await fetch(`${base}/api/search?q=Espumisan&kategoria=OTC`)).json()) as SearchResponse;
    const hit = search.items[0];
    expect(hit?.kategoriaDostepnosci).toBe("OTC");
    const eq = (await (await fetch(`${base}/api/equivalents?id=${hit?.id}`)).json()) as EquivalentsResult;
    expect(eq.wybrany.kategoriaDostepnosci).toBe("OTC");
    expect(eq.opisSubstancji.substancja).toBe("Simeticonum");
    expect(eq.liczbaWGrupie).toBe(2);
  });
});
