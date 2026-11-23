/**
 * Prosta pamięć podręczna LRU z czasem życia wpisów (TTL), bez zależności.
 *
 * `Map` zachowuje kolejność wstawiania, więc odczyt przenosi wpis na koniec (najświeższy),
 * a przy przepełnieniu usuwany jest pierwszy (najdawniej używany) wpis.
 * Używana dla `GET /api/search` (TTL 10 min) – powtarzające się zapytania nie trafiają do DuckDB.
 */
export interface TtlLruCacheOptions {
  /** Maksymalna liczba wpisów (≥ 1). */
  maxEntries: number;
  /** Czas życia wpisu w ms. */
  ttlMs: number;
  /** Źródło czasu (do testów wygasania). */
  now?: () => number;
}

export class TtlLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions) {
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries));
    this.ttlMs = Math.max(0, options.ttlMs);
    this.now = options.now ?? Date.now;
  }

  /** Liczba wpisów (łącznie z jeszcze nieusuniętymi wygasłymi). */
  get size(): number {
    return this.entries.size;
  }

  /** Zwraca wartość lub `undefined`, gdy brak wpisu albo wygasł (wygasły wpis jest usuwany). */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
