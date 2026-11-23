import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fetchData, formatMegabytes, formatProgressBar, readWithProgress } from "../scripts/fetch_data";
import { loadConfig } from "../src/config";
import { buildParquet, DrugDatabase } from "../src/db";
import { BUILTIN_OTC, RPL_CSV_URL } from "../src/otc";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");
const RPL_FIXTURE = resolve(import.meta.dir, "fixtures", "sample_rpl.csv");
const TODAY = "2026-11-23";

describe("pasek postępu pobierania", () => {
  test("formatProgressBar – format z procentami i MB", () => {
    const mb = 1024 * 1024;
    expect(formatProgressBar(1.8 * mb, 4.3 * mb)).toBe("[████░░░░░░] 41% · 1.8 MB / 4.3 MB");
    expect(formatProgressBar(0, 10 * mb)).toBe("[░░░░░░░░░░] 0% · 0.0 MB / 10.0 MB");
    expect(formatProgressBar(10 * mb, 10 * mb)).toBe("[██████████] 100% · 10.0 MB / 10.0 MB");
    expect(formatProgressBar(2 * mb, 0)).toBe("[░░░░░░░░░░] 2.0 MB");
    expect(formatMegabytes(1536 * 1024)).toBe("1.5 MB");
  });

  test("readWithProgress (log bez TTY) – zwraca bajty i wypisuje postęp co 25%", async () => {
    const payload = new Uint8Array(4000).map((_, i) => i % 251);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payload.length; i += 500) controller.enqueue(payload.slice(i, i + 500));
        controller.close();
      },
    });
    const response = new Response(stream, { headers: { "content-length": String(payload.length) } });
    const lines: string[] = [];
    const bytes = await readWithProgress(response, "Test", { write: (c) => lines.push(c), isTty: false });
    expect(bytes).toEqual(payload);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.at(-1)).toContain("[██████████] 100%");
    expect(lines.every((l) => l.startsWith("[fetch-data] Test ["))).toBe(true);
  });

  test("readWithProgress (TTY) – odświeża jedną linię przez \\r i kończy znakiem nowej linii", async () => {
    const response = new Response(new Uint8Array(1000), { headers: { "content-length": "1000" } });
    const chunks: string[] = [];
    await readWithProgress(response, "TTY", { write: (c) => chunks.push(c), isTty: true });
    expect(chunks.every((c) => c.startsWith("\r"))).toBe(true);
    expect(chunks.at(-1)).toEndWith("\n");
  });

  test("readWithProgress – skompresowana odpowiedź lub zaniżony Content-Length: same MB zamiast błędnych %", async () => {
    const gz = new Response(new Uint8Array(3000), { headers: { "content-length": "800", "content-encoding": "gzip" } });
    const lines: string[] = [];
    await readWithProgress(gz, "Gzip", { write: (c) => lines.push(c), isTty: false });
    expect(lines).toEqual(["[fetch-data] Gzip [░░░░░░░░░░] 0.0 MB\n"]);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const short = new Response(stream, { headers: { "content-length": "800" } });
    const out: string[] = [];
    await readWithProgress(short, "Zaniżony", { write: (c) => out.push(c), isTty: false });
    expect(out.at(-1)).not.toContain("%");
  });

  test("readWithProgress przerywa zbyt duży plik", async () => {
    const response = new Response(new Uint8Array(2048));
    await expect(readWithProgress(response, "Duży", { maxBytes: 1024, write: () => {} })).rejects.toThrow("zbyt duży");
  });
});

describe("fetchData – leki OTC z RPL i zachowanie dotychczasowych leków Rp", () => {
  let workDir: string;
  let rplServer: ReturnType<typeof Bun.serve>;
  let rplMode: "ok" | "down" = "ok";
  let rplUrl: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tanilek-etl-"));
    const rplBody = await readFile(RPL_FIXTURE);
    rplServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        rplMode === "ok"
          ? new Response(rplBody, { headers: { "content-type": "text/csv; charset=utf-8" } })
          : new Response("Service Unavailable", { status: 503 }),
    });
    rplUrl = `http://127.0.0.1:${rplServer.port}/rpl.csv`;
  });

  afterAll(async () => {
    rplServer.stop(true);
    await rm(workDir, { recursive: true, force: true });
  });

  /** Konfiguracja z niedostępnym źródłem MZ (odmowa połączenia) i lokalnym serwerem RPL. */
  function config(dataFile: string, rpl: string | null = rplUrl) {
    return loadConfig(
      {
        NODE_ENV: "test",
        DATA_FILE_PATH: dataFile,
        FALLBACK_CSV_PATH: FIXTURE,
        SOURCE_URL: "http://127.0.0.1:9/niedostepny-wykaz.csv",
        FETCH_TIMEOUT_MS: "2000",
        RPL_CSV_URL: rpl ?? "off",
      },
      workDir,
    );
  }

  const quiet = { log: () => {}, progressWrite: () => {}, today: TODAY };

  test("domyślny adres RPL i wyłączenie wartością „off”", () => {
    expect(loadConfig({}, workDir).rplCsvUrl).toBe(RPL_CSV_URL);
    expect(loadConfig({ RPL_CSV_URL: "off" }, workDir).rplCsvUrl).toBeNull();
  });

  test("brak wykazu MZ + istniejący pełny wykaz → zachowane leki Rp i dołączone OTC z RPL", async () => {
    const dataFile = join(workDir, "istniejacy.parquet");
    await buildParquet({
      inputPath: FIXTURE,
      kind: "csv",
      parquetPath: dataFile,
      meta: { source: "parquet", resource_url: "https://www.gov.pl/attachment/x", resource_title: "Obwieszczenie MZ" },
    });
    const outcome = await fetchData(config(dataFile), quiet);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.reusedExisting).toBe(true);
    expect(outcome.meta.source).toBe("parquet");
    expect(outcome.meta.resource_title).toBe("Obwieszczenie MZ");
    expect(outcome.meta.rows_rp).toBe(35);
    expect(outcome.meta.rows_otc).toBe(4);
    expect(outcome.meta.otc_source).toBe("rpl");

    const db = await DrugDatabase.open({ dataFilePath: dataFile, fallbackCsvPath: FIXTURE, poolSize: 1 });
    try {
      expect((await db.search("Atoris", 1)).data.items[0]?.kodAtc).toBe("C10AA05");
      expect((await db.search("Otrivin", 1)).data.items[0]?.kategoriaDostepnosci).toBe("OTC");
    } finally {
      db.close();
    }

    // Drugie uruchomienie (np. ponowny `bun run fetch-data`) nie dubluje pozycji OTC.
    const again = await fetchData(config(dataFile), quiet);
    expect(again.meta.rows_rp).toBe(35);
    expect(again.meta.rows_otc).toBe(4);
  });

  test("RPL niedostępny → wbudowany zestaw popularnych leków OTC", async () => {
    const dataFile = join(workDir, "bez-rpl.parquet");
    await buildParquet({
      inputPath: FIXTURE,
      kind: "csv",
      parquetPath: dataFile,
      meta: { source: "parquet", resource_url: null, resource_title: "Obwieszczenie MZ" },
    });
    rplMode = "down";
    try {
      const outcome = await fetchData(config(dataFile), quiet);
      expect(outcome.reusedExisting).toBe(true);
      expect(outcome.meta.rows_rp).toBe(35);
      expect(outcome.meta.rows_otc).toBe(BUILTIN_OTC.length);
      expect(outcome.meta.otc_source).toBe("builtin");
    } finally {
      rplMode = "ok";
    }
  });

  test("brak wykazu MZ i brak istniejącej bazy → tryb demo (z wbudowanymi lekami OTC)", async () => {
    const dataFile = join(workDir, "nowy.parquet");
    const outcome = await fetchData(config(dataFile, null), quiet);
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.meta.source).toBe("fallback-demo");
    expect(outcome.meta.rows_rp).toBe(35);
    expect(outcome.meta.rows_otc).toBe(BUILTIN_OTC.length);
  });

  test("istniejąca baza demo nie jest „zachowywana” – budowana jest od nowa", async () => {
    const dataFile = join(workDir, "demo-istniejace.parquet");
    await fetchData(config(dataFile, null), { ...quiet, demoOnly: true });
    const outcome = await fetchData(config(dataFile, null), quiet);
    expect(outcome.reusedExisting).toBeUndefined();
    expect(outcome.usedFallback).toBe(true);
  });
});
