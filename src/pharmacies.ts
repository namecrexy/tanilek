/**
 * Wyszukiwarka najbliższych aptek po kodzie pocztowym lub adresie.
 *
 * 1. Geokodowanie zapytania przez OpenStreetMap Nominatim (tylko Polska).
 * 2. Pobranie aptek (`amenity=pharmacy`, węzły i obrysy budynków) z Overpass API
 *    w promieniu 3 km, a przy braku wyników – 8 km. Odpytywane są kolejno 3 serwery lustrzane
 *    ({@link OVERPASS_MIRRORS}) z limitem 8 s na serwer; serwer, który odpowiedział, jest pierwszy
 *    w kolejnych zapytaniach (rotacja / failover).
 * 3. Wyliczenie odległości wzorem Haversine'a, sortowanie i zwrot maks. 8 najbliższych aptek.
 * 4. Tryb awaryjny: gdy adres znaleziono, a wszystkie serwery Overpass zawiodły – przykładowe apteki
 *    w okolicy z flagą `isFallback: true` zamiast błędu 502 (wyłączany `fallbackOnOverpassError: false`).
 *
 * Wyniki są przechowywane w pamięci przez 15 minut, aby nie obciążać publicznych serwerów OSM.
 * `fetchFn` można wstrzyknąć w testach – `bun test` nie wykonuje żadnych zapytań do sieci.
 */

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
/** Publiczne serwery lustrzane Overpass API w kolejności domyślnej. */
export const OVERPASS_MIRRORS: readonly string[] = Object.freeze([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]);
/** Główny serwer Overpass (pierwszy z {@link OVERPASS_MIRRORS}). */
export const OVERPASS_URL = OVERPASS_MIRRORS[0] as string;
export const OSM_USER_AGENT = "TaniLek/1.2.0 (open-source pharmacy finder)";

/** Kolejne promienie wyszukiwania w metrach – drugi używany tylko, gdy w pierwszym nie ma aptek. */
export const SEARCH_RADII_METERS = [3000, 8000] as const;
export const MAX_PHARMACIES = 8;
export const PHARMACY_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const GEOCODE_TIMEOUT_MS = 10_000;
/** Limit czasu pojedynczego serwera Overpass (po nim następuje przełączenie na kolejny). */
export const OVERPASS_TIMEOUT_MS = 8_000;
const EARTH_RADIUS_METERS = 6_371_008.8;

export const NOT_FOUND_MESSAGE = "Nie znaleziono podanego adresu ani kodu pocztowego w Polsce.";
export const UPSTREAM_ERROR_MESSAGE =
  "Usługa map OpenStreetMap jest chwilowo niedostępna. Spróbuj ponownie za kilka minut.";
export const FALLBACK_MESSAGE =
  "Serwery map OpenStreetMap nie odpowiadają – pokazujemy przykładowe apteki w okolicy (tryb awaryjny). " +
  "Sprawdź prawdziwe apteki w Mapach Google lub spróbuj ponownie za kilka minut.";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ResolvedLocation extends GeoPoint {
  displayName: string;
}

export interface Pharmacy extends GeoPoint {
  id: string;
  name: string;
  address: string | null;
  openingHours: string | null;
  phone: string | null;
  distanceMeters: number;
  navigationUrl: string;
}

export interface PharmacySearchResult {
  query: string;
  resolvedLocation: ResolvedLocation;
  radiusMeters: number;
  pharmacies: Pharmacy[];
  /** True – przykładowe apteki trybu awaryjnego (Overpass niedostępny), a nie dane z OpenStreetMap. */
  isFallback: boolean;
  /** Komunikat dla użytkownika w trybie awaryjnym. */
  fallbackReason?: string;
  /** Serwer Overpass, który zwrócił dane (null w trybie awaryjnym). */
  overpassServer: string | null;
  /** True, gdy wynik pochodzi z pamięci podręcznej (15 min). */
  cached: boolean;
  /** Czas wyszukiwania po stronie serwera (ms). */
  durationMs: number;
}

export interface FindPharmaciesOptions {
  fetchFn?: typeof fetch;
  /** Bieżący czas w ms (do testów wygasania cache). */
  now?: () => number;
  /** False – błąd 502 zamiast przykładowych aptek, gdy wszystkie serwery Overpass zawiodą (domyślnie true). */
  fallbackOnOverpassError?: boolean;
  /** Własna lista serwerów Overpass (domyślnie {@link OVERPASS_MIRRORS}). */
  overpassUrls?: readonly string[];
}

/** Błąd z kodem HTTP przeznaczonym dla klienta (404 – nie znaleziono adresu, 502 – awaria OSM). */
export class PharmacyLookupError extends Error {
  constructor(
    readonly status: 404 | 502,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PharmacyLookupError";
  }
}

/** Odległość po kole wielkim (wzór Haversine'a) w metrach. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function navigationUrl(point: GeoPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lon}`;
}

/** Zapytanie Overpass QL o apteki (węzły i obrysy) w promieniu `radius` metrów. */
export function buildOverpassQuery(center: GeoPoint, radius: number): string {
  const around = `(around:${radius},${center.lat},${center.lon})`;
  return `[out:json][timeout:10];(node["amenity"="pharmacy"]${around};way["amenity"="pharmacy"]${around};);out center tags;`;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string | undefined>;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatAddress(tags: Record<string, string | undefined>): string | null {
  const street = [clean(tags["addr:street"]), clean(tags["addr:housenumber"])].filter(Boolean).join(" ");
  const city = [clean(tags["addr:postcode"]), clean(tags["addr:city"])].filter(Boolean).join(" ");
  const address = [street, city].filter(Boolean).join(", ");
  return address || null;
}

/** Zamienia elementy odpowiedzi Overpass na apteki posortowane od najbliższej (maks. `limit`). */
export function parseOverpassElements(elements: unknown, origin: GeoPoint, limit = MAX_PHARMACIES): Pharmacy[] {
  if (!Array.isArray(elements)) return [];
  const seen = new Set<string>();
  const pharmacies: Pharmacy[] = [];
  for (const raw of elements as OverpassElement[]) {
    if (!raw || (raw.type !== "node" && raw.type !== "way")) continue;
    const lat = raw.type === "node" ? raw.lat : raw.center?.lat;
    const lon = raw.type === "node" ? raw.lon : raw.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id = `${raw.type}/${raw.id ?? `${lat},${lon}`}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = raw.tags ?? {};
    const point = { lat, lon };
    pharmacies.push({
      id,
      name: clean(tags.name) ?? "Apteka",
      address: formatAddress(tags),
      openingHours: clean(tags.opening_hours),
      phone: clean(tags.phone) ?? clean(tags["contact:phone"]),
      lat,
      lon,
      distanceMeters: Math.round(haversineMeters(origin, point)),
      navigationUrl: navigationUrl(point),
    });
  }
  pharmacies.sort((a, b) => a.distanceMeters - b.distanceMeters || a.name.localeCompare(b.name, "pl"));
  return pharmacies.slice(0, limit);
}

async function requestJson(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE, { cause: error });
  }
  if (!response.ok) {
    const cause = new Error(`HTTP ${response.status} z ${new URL(url).host}`);
    throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE, { cause });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE, { cause: error });
  }
}

async function geocode(query: string, fetchFn: typeof fetch): Promise<ResolvedLocation> {
  const params = new URLSearchParams({ format: "jsonv2", countrycodes: "pl", limit: "1", q: query });
  const data = await requestJson(
    fetchFn,
    `${NOMINATIM_URL}?${params}`,
    { headers: { "User-Agent": OSM_USER_AGENT, "Accept-Language": "pl", Accept: "application/json" } },
    GEOCODE_TIMEOUT_MS,
  );
  if (!Array.isArray(data)) throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE);
  const first = data[0] as { lat?: unknown; lon?: unknown; display_name?: unknown } | undefined;
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  if (!first || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new PharmacyLookupError(404, NOT_FOUND_MESSAGE);
  return { lat, lon, displayName: typeof first.display_name === "string" ? first.display_name : query };
}

/** Indeks serwera lustrzanego, który ostatnio odpowiedział poprawnie. */
let preferredMirror = 0;

/** Kolejność serwerów do odpytania: od ostatnio działającego, potem pozostałe (rotacja). */
function mirrorOrder(urls: readonly string[]): string[] {
  const start = preferredMirror % urls.length;
  return [...urls.slice(start), ...urls.slice(0, start)];
}

/** Wynik zapytania Overpass z adresem serwera, który odpowiedział. */
interface OverpassAnswer {
  pharmacies: Pharmacy[];
  server: string;
}

/**
 * Pobiera apteki z Overpass API, odpytując kolejno serwery lustrzane (limit czasu
 * {@link OVERPASS_TIMEOUT_MS} na serwer). Serwer, który odpowiedział, staje się pierwszym
 * w kolejnych zapytaniach. Gdy wszystkie zawiodą – {@link PharmacyLookupError} 502 z listą błędów.
 */
async function fetchPharmacies(
  center: GeoPoint,
  radius: number,
  fetchFn: typeof fetch,
  urls: readonly string[],
): Promise<OverpassAnswer> {
  const failures: string[] = [];
  const body = new URLSearchParams({ data: buildOverpassQuery(center, radius) }).toString();
  for (const url of mirrorOrder(urls)) {
    try {
      const data = await requestJson(
        fetchFn,
        url,
        {
          method: "POST",
          headers: {
            "User-Agent": OSM_USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            Accept: "application/json",
          },
          body,
        },
        OVERPASS_TIMEOUT_MS,
      );
      const elements = (data as { elements?: unknown } | null)?.elements;
      if (!Array.isArray(elements)) {
        throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE, { cause: new Error("brak pola „elements”") });
      }
      preferredMirror = Math.max(0, urls.indexOf(url));
      return { pharmacies: parseOverpassElements(elements, center), server: url };
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
      failures.push(`${new URL(url).host}: ${cause}`);
    }
  }
  throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE, {
    cause: new Error(`wszystkie serwery Overpass zawiodły (${failures.join("; ")})`),
  });
}

/* -------------------------------------------------------------------------- */
/*  Tryb awaryjny                                                             */
/* -------------------------------------------------------------------------- */

/** Przykładowe nazwy aptek trybu awaryjnego (typowe, ogólne nazwy – nie konkretne placówki). */
const FALLBACK_NAMES = [
  "Apteka Centralna",
  "Apteka Rodzinna",
  "Apteka Pod Lipami",
  "Apteka Zdrowie",
  "Apteka Na Rogu",
  "Apteka Przy Rynku",
] as const;

/** Odległości (m) i kierunki (stopnie) przykładowych aptek względem wyszukanego punktu. */
const FALLBACK_LAYOUT: readonly [distance: number, bearing: number][] = [
  [320, 35],
  [610, 140],
  [880, 260],
  [1250, 315],
  [1700, 200],
  [2300, 80],
];

/** Punkt przesunięty o `distance` metrów w kierunku `bearingDeg` (przybliżenie lokalne). */
export function offsetPoint(origin: GeoPoint, distance: number, bearingDeg: number): GeoPoint {
  const bearing = (bearingDeg * Math.PI) / 180;
  const dLat = (distance * Math.cos(bearing)) / 111_320;
  const dLon = (distance * Math.sin(bearing)) / (111_320 * Math.cos((origin.lat * Math.PI) / 180));
  return { lat: Number((origin.lat + dLat).toFixed(6)), lon: Number((origin.lon + dLon).toFixed(6)) };
}

/** Link do wyszukiwania aptek w Mapach Google wokół punktu (prawdziwe apteki w okolicy). */
export function mapSearchUrl(point: GeoPoint): string {
  return `https://www.google.com/maps/search/apteka/@${point.lat},${point.lon},16z`;
}

/**
 * Przykładowe apteki w okolicy wyszukanego punktu (tryb awaryjny, gdy Overpass jest niedostępny).
 * Odległość liczona jest wzorem Haversine'a; „Nawiguj” otwiera wyszukiwanie aptek w Mapach Google
 * wokół wyszukanego adresu, bo przykładowe pozycje nie są konkretnymi placówkami.
 */
export function fallbackPharmacies(location: ResolvedLocation): Pharmacy[] {
  const area = location.displayName.split(",")[0]?.trim() || "wyszukiwany adres";
  return FALLBACK_LAYOUT.map(([distance, bearing], i) => {
    const point = offsetPoint(location, distance, bearing);
    return {
      id: `fallback/${i + 1}`,
      name: FALLBACK_NAMES[i % FALLBACK_NAMES.length] as string,
      address: `okolice: ${area} (przykładowa lokalizacja)`,
      openingHours: null,
      phone: null,
      lat: point.lat,
      lon: point.lon,
      distanceMeters: Math.round(haversineMeters(location, point)),
      navigationUrl: mapSearchUrl(location),
    };
  }).sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/* -------------------------------------------------------------------------- */
/*  Wyszukiwanie z pamięcią podręczną                                         */
/* -------------------------------------------------------------------------- */

type CachedSearch = Omit<PharmacySearchResult, "cached" | "durationMs">;

const cache = new Map<string, { expiresAt: number; value: CachedSearch }>();

/** Czyści cache wyników i przywraca domyślną kolejność serwerów Overpass (używane w testach). */
export function clearPharmacyCache(): void {
  cache.clear();
  preferredMirror = 0;
}

function cacheKey(query: string): string {
  return query.trim().toLocaleLowerCase("pl").replace(/\s+/g, " ");
}

/**
 * Szuka maks. 8 najbliższych aptek dla podanego kodu pocztowego lub adresu w Polsce.
 *
 * Gdy Nominatim znajdzie adres, ale wszystkie serwery Overpass zawiodą, zwracane są przykładowe
 * apteki w okolicy z flagą `isFallback: true` (chyba że `fallbackOnOverpassError: false` – wtedy błąd 502).
 * Wyniki trybu awaryjnego nie trafiają do cache – kolejne zapytanie ponownie spróbuje Overpass.
 */
export async function findNearbyPharmacies(
  query: string,
  options: FindPharmaciesOptions = {},
): Promise<PharmacySearchResult> {
  const startedAt = performance.now();
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const urls = options.overpassUrls && options.overpassUrls.length > 0 ? options.overpassUrls : OVERPASS_MIRRORS;
  const trimmed = query.trim().replace(/\s+/g, " ");
  const key = cacheKey(trimmed);
  const elapsed = () => Math.round((performance.now() - startedAt) * 1000) / 1000;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return { ...hit.value, cached: true, durationMs: elapsed() };
  if (hit) cache.delete(key);

  const location = await geocode(trimmed, fetchFn);
  let radiusMeters: number = SEARCH_RADII_METERS[0];
  let answer: OverpassAnswer | null = null;
  try {
    for (const radius of SEARCH_RADII_METERS) {
      radiusMeters = radius;
      answer = await fetchPharmacies(location, radius, fetchFn, urls);
      if (answer.pharmacies.length > 0) break;
    }
  } catch (error) {
    if (options.fallbackOnOverpassError === false || !(error instanceof PharmacyLookupError)) throw error;
    const cause = error.cause instanceof Error ? error.cause.message : error.message;
    console.warn(`[apteki] Tryb awaryjny – ${cause}`);
    return {
      query: trimmed,
      resolvedLocation: location,
      radiusMeters: SEARCH_RADII_METERS[0],
      pharmacies: fallbackPharmacies(location),
      isFallback: true,
      fallbackReason: FALLBACK_MESSAGE,
      overpassServer: null,
      cached: false,
      durationMs: elapsed(),
    };
  }

  const value: CachedSearch = {
    query: trimmed,
    resolvedLocation: location,
    radiusMeters,
    pharmacies: answer?.pharmacies ?? [],
    isFallback: false,
    overpassServer: answer?.server ?? null,
  };
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: now() + PHARMACY_CACHE_TTL_MS, value });
  return { ...value, cached: false, durationMs: elapsed() };
}
