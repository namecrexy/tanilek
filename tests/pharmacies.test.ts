import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { DrugDatabase } from "../src/db";
import {
  buildOverpassQuery,
  clearPharmacyCache,
  findNearbyPharmacies,
  haversineMeters,
  MAX_PHARMACIES,
  NOMINATIM_URL,
  NOT_FOUND_MESSAGE,
  OSM_USER_AGENT,
  OVERPASS_URL,
  PHARMACY_CACHE_TTL_MS,
  PharmacyLookupError,
  type PharmacySearchResult,
  parseOverpassElements,
} from "../src/pharmacies";
import { createServer } from "../src/server";

const FIXTURE = resolve(import.meta.dir, "fixtures", "sample_leki.csv");

/** Centrum Warszawy (okolice ul. Marszałkowskiej). */
const ORIGIN = { lat: 52.2297, lon: 21.0122 };

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

interface MockOsm {
  fetchFn: typeof fetch;
  calls: RecordedCall[];
  overpassRadii: () => number[];
}

type OverpassHandler = (radius: number) => unknown;

/** Atrapa `fetch` symulująca Nominatim i Overpass – testy nie wychodzą do sieci. */
function mockOsm(options: {
  geocode?: unknown;
  geocodeStatus?: number;
  overpass?: OverpassHandler;
  overpassStatus?: number;
  throwOn?: "nominatim" | "overpass";
}): MockOsm {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url.startsWith(NOMINATIM_URL)) {
      if (options.throwOn === "nominatim") throw new TypeError("fetch failed");
      return Response.json(
        options.geocode ?? [{ lat: String(ORIGIN.lat), lon: String(ORIGIN.lon), display_name: "Warszawa" }],
        {
          status: options.geocodeStatus ?? 200,
        },
      );
    }
    if (url === OVERPASS_URL) {
      if (options.throwOn === "overpass") throw new TypeError("fetch failed");
      const query = new URLSearchParams(String(init?.body)).get("data") ?? "";
      const radius = Number(/around:(\d+),/.exec(query)?.[1]);
      return Response.json(options.overpass ? options.overpass(radius) : { elements: [] }, {
        status: options.overpassStatus ?? 200,
      });
    }
    return new Response("nieoczekiwany adres", { status: 500 });
  }) as typeof fetch;
  return {
    fetchFn,
    calls,
    overpassRadii: () =>
      calls
        .filter((c) => c.url === OVERPASS_URL)
        .map((c) => Number(/around:(\d+),/.exec(new URLSearchParams(String(c.init?.body)).get("data") ?? "")?.[1])),
  };
}

/** Punkt przesunięty o `meters` na północ od ORIGIN (1° szerokości ≈ 111 195 m). */
function north(meters: number) {
  return { lat: ORIGIN.lat + meters / 111_195, lon: ORIGIN.lon };
}

const NEAR_ELEMENTS = {
  elements: [
    {
      type: "way",
      id: 200,
      center: north(1400),
      tags: {
        amenity: "pharmacy",
        name: "Apteka Daleka",
        "addr:street": "Puławska",
        "addr:housenumber": "12",
        "addr:postcode": "02-512",
        "addr:city": "Warszawa",
      },
    },
    { type: "node", id: 100, ...north(350), tags: { amenity: "pharmacy", opening_hours: "Mo-Fr 08:00-20:00" } },
    {
      type: "node",
      id: 101,
      ...north(900),
      tags: { amenity: "pharmacy", name: "Apteka Średnia", phone: "+48 22 000 00 00" },
    },
    { type: "way", id: 201, tags: { name: "Bez współrzędnych" } },
    { type: "relation", id: 300, ...north(10), tags: { name: "Relacja" } },
  ],
};

beforeEach(() => clearPharmacyCache());

describe("haversineMeters", () => {
  test("zwraca 0 dla tego samego punktu i jest symetryczna", () => {
    expect(haversineMeters(ORIGIN, ORIGIN)).toBe(0);
    const krakow = { lat: 50.0647, lon: 19.945 };
    expect(haversineMeters(ORIGIN, krakow)).toBeCloseTo(haversineMeters(krakow, ORIGIN), 6);
  });

  test("odległość Warszawa – Kraków ≈ 252 km w linii prostej", () => {
    const distance = haversineMeters(ORIGIN, { lat: 50.0647, lon: 19.945 });
    expect(distance).toBeGreaterThan(250_000);
    expect(distance).toBeLessThan(254_000);
  });

  test("1 km na północ daje ≈ 1000 m", () => {
    expect(Math.round(haversineMeters(ORIGIN, north(1000)))).toBe(1000);
  });
});

describe("parseOverpassElements", () => {
  test("parsuje node i way (center), sortuje od najbliższej i pomija elementy bez współrzędnych", () => {
    const pharmacies = parseOverpassElements(NEAR_ELEMENTS.elements, ORIGIN);
    expect(pharmacies.map((p) => p.id)).toEqual(["node/100", "node/101", "way/200"]);
    expect(pharmacies.map((p) => p.distanceMeters)).toEqual([350, 900, 1400]);

    const [first, second, third] = pharmacies;
    expect(first?.name).toBe("Apteka");
    expect(first?.openingHours).toBe("Mo-Fr 08:00-20:00");
    expect(first?.address).toBeNull();
    expect(second?.phone).toBe("+48 22 000 00 00");
    expect(third?.name).toBe("Apteka Daleka");
    expect(third?.address).toBe("Puławska 12, 02-512 Warszawa");
    expect(third?.lat).toBeCloseTo(north(1400).lat, 9);
    expect(third?.navigationUrl).toBe(`https://www.google.com/maps/dir/?api=1&destination=${third?.lat},${third?.lon}`);
  });

  test(`zwraca maksymalnie ${MAX_PHARMACIES} najbliższych aptek`, () => {
    const elements = Array.from({ length: 12 }, (_, i) => ({
      type: "node",
      id: i,
      ...north((12 - i) * 100),
      tags: { name: `Apteka ${i}` },
    }));
    const pharmacies = parseOverpassElements(elements, ORIGIN);
    expect(pharmacies).toHaveLength(MAX_PHARMACIES);
    expect(pharmacies[0]?.name).toBe("Apteka 11");
    const distances = pharmacies.map((p) => p.distanceMeters);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  test("odporność na niepoprawne dane", () => {
    expect(parseOverpassElements(null, ORIGIN)).toEqual([]);
    expect(parseOverpassElements([null, { type: "node" }, { type: "node", lat: "52", lon: 21 }], ORIGIN)).toEqual([]);
  });

  test("buildOverpassQuery pyta o node i way z out center tags", () => {
    const q = buildOverpassQuery(ORIGIN, 3000);
    expect(q).toContain(`node["amenity"="pharmacy"](around:3000,${ORIGIN.lat},${ORIGIN.lon})`);
    expect(q).toContain(`way["amenity"="pharmacy"](around:3000,${ORIGIN.lat},${ORIGIN.lon})`);
    expect(q).toContain("out center tags;");
  });
});

describe("findNearbyPharmacies", () => {
  test("geokoduje przez Nominatim z wymaganymi nagłówkami i pyta Overpass metodą POST", async () => {
    const osm = mockOsm({ overpass: () => NEAR_ELEMENTS });
    const result = await findNearbyPharmacies("  00-001  ", { fetchFn: osm.fetchFn });

    const nominatim = osm.calls[0];
    const nominatimUrl = new URL(nominatim?.url ?? "");
    expect(`${nominatimUrl.origin}${nominatimUrl.pathname}`).toBe(NOMINATIM_URL);
    expect(nominatimUrl.searchParams.get("format")).toBe("jsonv2");
    expect(nominatimUrl.searchParams.get("countrycodes")).toBe("pl");
    expect(nominatimUrl.searchParams.get("limit")).toBe("1");
    expect(nominatimUrl.searchParams.get("q")).toBe("00-001");
    const headers = new Headers(nominatim?.init?.headers);
    expect(headers.get("user-agent")).toBe(OSM_USER_AGENT);
    expect(headers.get("accept-language")).toBe("pl");

    const overpass = osm.calls[1];
    expect(overpass?.url).toBe(OVERPASS_URL);
    expect(overpass?.init?.method).toBe("POST");

    expect(result.query).toBe("00-001");
    expect(result.resolvedLocation).toEqual({ ...ORIGIN, displayName: "Warszawa" });
    expect(result.radiusMeters).toBe(3000);
    expect(result.pharmacies).toHaveLength(3);
    expect(osm.overpassRadii()).toEqual([3000]);
  });

  test("rozszerza promień z 3 km do 8 km, gdy w pobliżu nie ma aptek", async () => {
    const osm = mockOsm({
      overpass: (radius) =>
        radius === 8000 ? { elements: [{ type: "node", id: 1, ...north(5200) }] } : { elements: [] },
    });
    const result = await findNearbyPharmacies("Wieś Mała 1", { fetchFn: osm.fetchFn });
    expect(osm.overpassRadii()).toEqual([3000, 8000]);
    expect(result.radiusMeters).toBe(8000);
    expect(result.pharmacies).toHaveLength(1);
    expect(result.pharmacies[0]?.distanceMeters).toBe(5200);
  });

  test("zwraca pustą listę z promieniem 8 km, gdy nie ma aptek także w szerszym promieniu", async () => {
    const osm = mockOsm({ overpass: () => ({ elements: [] }) });
    const result = await findNearbyPharmacies("Pustkowie", { fetchFn: osm.fetchFn });
    expect(result.radiusMeters).toBe(8000);
    expect(result.pharmacies).toEqual([]);
  });

  test("cache w pamięci: powtórne zapytanie (inna wielkość liter/spacje) nie odpytuje OSM", async () => {
    const osm = mockOsm({ overpass: () => NEAR_ELEMENTS });
    const first = await findNearbyPharmacies("Warszawa, Marszałkowska 10", { fetchFn: osm.fetchFn });
    const second = await findNearbyPharmacies("  warszawa,   MARSZAŁKOWSKA 10 ", { fetchFn: osm.fetchFn });
    expect(second).toBe(first);
    expect(osm.calls).toHaveLength(2);
  });

  test("cache wygasa po 15 minutach", async () => {
    const osm = mockOsm({ overpass: () => NEAR_ELEMENTS });
    let now = 1_000_000;
    const opts = { fetchFn: osm.fetchFn, now: () => now };
    await findNearbyPharmacies("00-001", opts);
    now += PHARMACY_CACHE_TTL_MS - 1;
    await findNearbyPharmacies("00-001", opts);
    expect(osm.calls).toHaveLength(2);
    now += 2;
    await findNearbyPharmacies("00-001", opts);
    expect(osm.calls).toHaveLength(4);
  });

  test("404 gdy Nominatim nie znajdzie adresu (wynik nie trafia do cache)", async () => {
    const osm = mockOsm({ geocode: [] });
    const error = await findNearbyPharmacies("99-999 Nigdzie", { fetchFn: osm.fetchFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PharmacyLookupError);
    expect((error as PharmacyLookupError).status).toBe(404);
    expect((error as PharmacyLookupError).message).toBe(NOT_FOUND_MESSAGE);
    await findNearbyPharmacies("99-999 Nigdzie", { fetchFn: osm.fetchFn }).catch(() => null);
    expect(osm.calls).toHaveLength(2);
  });

  test.each([
    ["błąd sieci Nominatim", { throwOn: "nominatim" as const }],
    ["HTTP 503 z Nominatim", { geocodeStatus: 503 }],
    ["błąd sieci Overpass", { throwOn: "overpass" as const }],
    ["HTTP 429 z Overpass", { overpassStatus: 429 }],
    ["niepoprawna odpowiedź Overpass", { overpass: () => ({ remark: "runtime error" }) }],
  ])("502 – %s", async (_name, options) => {
    const osm = mockOsm(options);
    const error = await findNearbyPharmacies("00-001", { fetchFn: osm.fetchFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PharmacyLookupError);
    expect((error as PharmacyLookupError).status).toBe(502);
  });
});

describe("GET /api/pharmacies (zamockowany fetch)", () => {
  let workDir: string;
  let db: DrugDatabase;
  let server: Awaited<ReturnType<typeof createServer>>;
  let base: string;
  let osm: MockOsm;
  let mode: "ok" | "not-found" | "down" = "ok";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tanilek-apteki-"));
    const config = loadConfig(
      { NODE_ENV: "test", PORT: "0", DATA_FILE_PATH: join(workDir, "leki.parquet"), FALLBACK_CSV_PATH: FIXTURE },
      workDir,
    );
    db = await DrugDatabase.open({ dataFilePath: config.dataFilePath, fallbackCsvPath: config.fallbackCsvPath });
    const ok = mockOsm({ overpass: () => NEAR_ELEMENTS });
    const notFound = mockOsm({ geocode: [] });
    const down = mockOsm({ throwOn: "overpass" });
    osm = ok;
    const pharmacyFetch = ((input: string | URL | Request, init?: RequestInit) =>
      (mode === "ok" ? ok : mode === "not-found" ? notFound : down).fetchFn(input, init)) as typeof fetch;
    server = await createServer({ config, db, port: 0, hostname: "127.0.0.1", pharmacyFetch });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mode = "ok";
  });

  test("zwraca { query, resolvedLocation, radiusMeters, pharmacies } i korzysta z cache", async () => {
    const callsBefore = osm.calls.length;
    const res = await fetch(`${base}/api/pharmacies?q=${encodeURIComponent("00-001 Warszawa")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as PharmacySearchResult;
    expect(body.query).toBe("00-001 Warszawa");
    expect(body.resolvedLocation.displayName).toBe("Warszawa");
    expect(body.radiusMeters).toBe(3000);
    expect(body.pharmacies.map((p) => p.distanceMeters)).toEqual([350, 900, 1400]);
    expect(body.pharmacies[0]?.navigationUrl).toStartWith("https://www.google.com/maps/dir/?api=1&destination=");
    expect(osm.calls.length - callsBefore).toBe(2);

    const again = await fetch(`${base}/api/pharmacies?q=${encodeURIComponent("00-001 warszawa")}`);
    expect(again.status).toBe(200);
    await again.arrayBuffer();
    expect(osm.calls.length - callsBefore).toBe(2);
  });

  test.each([
    ["brak zapytania", ""],
    ["za krótkie zapytanie", "q=ab"],
    ["same spacje", "q=%20%20%20%20"],
    ["za długie zapytanie", `q=${"x".repeat(121)}`],
  ])("400 – %s", async (_name, query) => {
    const res = await fetch(`${base}/api/pharmacies?${query}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toContain("'q'");
  });

  test("akceptuje zapytanie o długości 120 znaków", async () => {
    const res = await fetch(`${base}/api/pharmacies?q=${"x".repeat(120)}`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  test("404 z czytelnym komunikatem, gdy adres nie istnieje", async () => {
    mode = "not-found";
    const res = await fetch(`${base}/api/pharmacies?q=nieistniejace-miejsce`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(NOT_FOUND_MESSAGE);
  });

  test("502 z komunikatem po polsku przy awarii OpenStreetMap", async () => {
    mode = "down";
    const res = await fetch(`${base}/api/pharmacies?q=awaria-osm`);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toContain("OpenStreetMap");
  });
});
