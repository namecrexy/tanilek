/**
 * Wyszukiwarka najbliższych aptek po kodzie pocztowym lub adresie.
 *
 * 1. Geokodowanie zapytania przez OpenStreetMap Nominatim (tylko Polska).
 * 2. Pobranie aptek (`amenity=pharmacy`, węzły i obrysy budynków) z Overpass API
 *    w promieniu 3 km, a przy braku wyników – 8 km.
 * 3. Wyliczenie odległości wzorem Haversine'a, sortowanie i zwrot maks. 8 najbliższych aptek.
 *
 * Wyniki są przechowywane w pamięci przez 15 minut, aby nie obciążać publicznych serwerów OSM.
 * `fetchFn` można wstrzyknąć w testach – `bun test` nie wykonuje żadnych zapytań do sieci.
 */

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OSM_USER_AGENT = "TaniLek/1.1.0 (open-source pharmacy finder)";

/** Kolejne promienie wyszukiwania w metrach – drugi używany tylko, gdy w pierwszym nie ma aptek. */
export const SEARCH_RADII_METERS = [3000, 8000] as const;
export const MAX_PHARMACIES = 8;
export const PHARMACY_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const GEOCODE_TIMEOUT_MS = 10_000;
const OVERPASS_TIMEOUT_MS = 35_000;
const EARTH_RADIUS_METERS = 6_371_008.8;

export const NOT_FOUND_MESSAGE = "Nie znaleziono podanego adresu ani kodu pocztowego w Polsce.";
export const UPSTREAM_ERROR_MESSAGE =
  "Usługa map OpenStreetMap jest chwilowo niedostępna. Spróbuj ponownie za kilka minut.";

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
}

export interface FindPharmaciesOptions {
  fetchFn?: typeof fetch;
  /** Bieżący czas w ms (do testów wygasania cache). */
  now?: () => number;
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
  return `[out:json][timeout:25];(node["amenity"="pharmacy"]${around};way["amenity"="pharmacy"]${around};);out center tags;`;
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

async function fetchPharmacies(center: GeoPoint, radius: number, fetchFn: typeof fetch): Promise<Pharmacy[]> {
  const data = await requestJson(
    fetchFn,
    OVERPASS_URL,
    {
      method: "POST",
      headers: {
        "User-Agent": OSM_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Accept: "application/json",
      },
      body: new URLSearchParams({ data: buildOverpassQuery(center, radius) }).toString(),
    },
    OVERPASS_TIMEOUT_MS,
  );
  const elements = (data as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) throw new PharmacyLookupError(502, UPSTREAM_ERROR_MESSAGE);
  return parseOverpassElements(elements, center);
}

const cache = new Map<string, { expiresAt: number; value: PharmacySearchResult }>();

/** Czyści cache wyników (używane w testach). */
export function clearPharmacyCache(): void {
  cache.clear();
}

function cacheKey(query: string): string {
  return query.trim().toLocaleLowerCase("pl").replace(/\s+/g, " ");
}

/** Szuka maks. 8 najbliższych aptek dla podanego kodu pocztowego lub adresu w Polsce. */
export async function findNearbyPharmacies(
  query: string,
  options: FindPharmaciesOptions = {},
): Promise<PharmacySearchResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const trimmed = query.trim().replace(/\s+/g, " ");
  const key = cacheKey(trimmed);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.value;
  if (cached) cache.delete(key);

  const location = await geocode(trimmed, fetchFn);
  let radiusMeters: number = SEARCH_RADII_METERS[0];
  let pharmacies: Pharmacy[] = [];
  for (const radius of SEARCH_RADII_METERS) {
    radiusMeters = radius;
    pharmacies = await fetchPharmacies(location, radius, fetchFn);
    if (pharmacies.length > 0) break;
  }

  const value: PharmacySearchResult = { query: trimmed, resolvedLocation: location, radiusMeters, pharmacies };
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: now() + PHARMACY_CACHE_TTL_MS, value });
  return value;
}
