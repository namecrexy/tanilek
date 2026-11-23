/**
 * Wspólne typy domenowe aplikacji TaniLek.
 * Nazwy pól odpowiadają znormalizowanym kolumnom pliku `data/leki.parquet`.
 */

/**
 * Kategoria dostępności leku:
 *  - „Rp” – lek refundowany na receptę z obwieszczenia MZ (urzędowa cena i dopłata pacjenta),
 *  - „OTC” – lek bez recepty z Rejestru Produktów Leczniczych (cena rynkowa nieregulowana – orientacyjna średnia).
 */
export type KategoriaDostepnosci = "Rp" | "OTC";

/** Filtr kategorii w wyszukiwarce („wszystkie” = brak filtra). */
export type KategoriaFiltr = KategoriaDostepnosci | "wszystkie";

/** Pojedyncza pozycja bazy leków (jedno opakowanie, jeden kod EAN). */
export interface DrugRecord {
  id: number;
  /** Nazwa handlowa, np. "Atoris". */
  nazwa: string;
  /** Substancja czynna (INN), np. "Atorvastatinum". */
  substancja_czynna: string;
  /** Moc / dawka, np. "20 mg". */
  dawka: string;
  /** Postać farmaceutyczna, np. "tabl. powl.". */
  postac: string;
  /** Zawartość opakowania, np. "30 szt.". */
  opakowanie: string;
  /** Liczba jednostek w opakowaniu odczytana z pola `opakowanie` (null, gdy nie da się jej ustalić). */
  liczba_jednostek: number | null;
  kod_ean: string;
  /** Poziom odpłatności, np. "ryczałt", "30%", "50%", "100%". */
  poziom_odplatnosci: string;
  /** Kwota, którą płaci pacjent w aptece (PLN). */
  doplata_pacjenta: number;
  /** Cena detaliczna brutto (PLN). */
  cena_detaliczna: number;
  /** Zakres wskazań objętych refundacją (dla OTC – pusty). */
  wskazanie: string;
  /** „Rp” – refundowany na receptę (NFZ), „OTC” – bez recepty. */
  kategoriaDostepnosci: KategoriaDostepnosci;
  /** True dla leków z wykazu refundacyjnego MZ. */
  czyRefundowany: boolean;
  /** Kod ATC (np. „N02BE01”) z rejestru RPL lub arkusza źródłowego; null, gdy nieznany. */
  kodAtc: string | null;
}

/** Pozycja wyniku wyszukiwania wzbogacona o informacje o grupie zamienników. */
export interface SearchHit extends DrugRecord {
  /** Liczba innych leków z tą samą substancją czynną, dawką i postacią. */
  liczba_zamiennikow: number;
  /** Najniższa dopłata pacjenta w grupie zamienników (PLN). */
  najnizsza_doplata_w_grupie: number;
  /** Maksymalna możliwa oszczędność na opakowaniu względem tego leku (PLN, ≥ 0). */
  mozliwa_oszczednosc: number;
  /** Średnia dopłata / cena w grupie zamienników (PLN, zaokrąglona do groszy). */
  sredniaCena: number;
  /** Liczba leków (opakowań) w grupie zamienników, łącznie z tym lekiem. */
  liczbaWGrupie: number;
  /**
   * Rodzaj trafienia, wg którego pozycja trafiła do rankingu (kolejność na liście):
   * „nazwa” / „alias” (dokładny alias całego zapytania) → „substancja” (także rozpoznana
   * z polskiej nazwy) / „objawy” (opis „Na co pomaga” lub wskazanie) → „przyblizone” (Jaro-Winkler).
   */
  dopasowanie?: SearchHitMatch;
}

/** Rodzaj trafienia pojedynczego wyniku wyszukiwania. */
export type SearchHitMatch = "nazwa" | "alias" | "substancja" | "objawy" | "przyblizone";

/** Liczba pasujących pozycji w każdej kategorii (niezależnie od aktywnego filtra i limitu). */
export interface CategoryCounts {
  wszystkie: number;
  Rp: number;
  OTC: number;
}

/**
 * Sposób dopasowania wyników:
 * (wg najlepszego trafienia w rankingu – niżej na liście mogą być trafienia innego rodzaju):
 *  - „direct” – bezpośrednie dopasowanie nazwy, substancji, opisu „Na co pomaga”, wskazania lub EAN,
 *  - „alias” – zapytanie przetłumaczone słownikiem marek / polskich nazw (np. apap → Paracetamolum),
 *  - „fuzzy” – wyłącznie wyniki przybliżone (literówka) wg podobieństwa Jaro-Winklera.
 */
export type SearchMatchMode = "direct" | "alias" | "fuzzy";

export interface SearchResult {
  query: string;
  count: number;
  items: SearchHit[];
  /** Sposób dopasowania (brak pola = „direct” dla zgodności wstecznej). */
  matchMode?: SearchMatchMode;
  /** Rozpoznana łacińska substancja czynna (tylko dla „alias”). */
  resolvedSubstance?: string;
  /** Komunikat dla użytkownika, np. „Rozpoznano substancję: Paracetamolum (dla zapytania: apap)”. */
  resolvedNote?: string;
  /** Aktywny filtr kategorii („wszystkie”, „Rp” lub „OTC”). */
  kategoria?: KategoriaFiltr;
  /** Liczniki pozycji w kategoriach dla tego samego zapytania. */
  liczniki?: CategoryCounts;
}

/** Odpowiedź `GET /api/search` – wynik wyszukiwania z informacją o pamięci podręcznej. */
export interface SearchResponse extends SearchResult {
  /** True, gdy odpowiedź pochodzi z pamięci podręcznej serwera (LRU/TTL 10 min). */
  cached: boolean;
  /** Czas obsługi zapytania po stronie serwera (ms). */
  durationMs: number;
}

/** Wynik porównania wybranego leku z jednym zamiennikiem. */
export interface SavingsQuote {
  lek: DrugRecord;
  /** True, jeśli pozycja jest lekiem wybranym przez użytkownika. */
  jest_wybranym: boolean;
  /**
   * Dopłata za zamiennik przeliczona na wielkość opakowania wybranego leku
   * (gdy liczby jednostek są znane i różne), w PLN.
   */
  doplata_porownawcza: number;
  /** Oszczędność w PLN (dodatnia = zamiennik tańszy, ujemna = droższy). */
  oszczednosc_pln: number;
  /** Oszczędność w procentach względem dopłaty za wybrany lek. */
  oszczednosc_proc: number;
  /** True, jeśli dopłatę przeliczono z powodu różnej wielkości opakowań. */
  przeliczono_na_opakowanie: boolean;
}

/** Opis substancji czynnej dla pacjenta: na co pomaga i jak stosować. */
export interface SubstanceDescription {
  /** Krótka etykieta grupy leków, np. „Lek przeciwbólowy i przeciwzapalny”. */
  kategoria: string;
  /** Przystępny opis (1–2 zdania), w jakich dolegliwościach stosuje się substancję. */
  naCoPomaga: string;
  /** Zwięzła, praktyczna wskazówka o sposobie przyjmowania. */
  jakStosowac: string;
  /**
   * Pochodzenie opisu:
   *  - „slownik” – opis substancji ze słownika `src/aliases.ts`,
   *  - „atc” – automatyczny opis grupy na podstawie prefiksu kodu ATC (`src/atc.ts`),
   *  - „ogolny” – opis zastępczy wygenerowany z pól `wskazanie` i `postac` (rzadka substancja).
   */
  zrodlo: "slownik" | "atc" | "ogolny";
  /** Substancja ze słownika, której opis użyto (null dla opisu ogólnego). */
  substancja: string | null;
}

export interface EquivalentsResult {
  wybrany: DrugRecord;
  /** Zakres wskazań refundacyjnych wybranego leku z obwieszczenia MZ (kolumna `wskazanie`). */
  wskazanie: string;
  /** Opis substancji czynnej wybranego leku: na co pomaga i jak stosować. */
  opisSubstancji: SubstanceDescription;
  /** Wszystkie leki z grupy (łącznie z wybranym) posortowane od najtańszego. */
  zamienniki: SavingsQuote[];
  /** Najkorzystniejszy zamiennik inny niż wybrany lek (null, gdy brak tańszego). */
  najlepsza_oferta: SavingsQuote | null;
  /**
   * Średnia cena w grupie zamienników (PLN): średnia dopłat porównawczych (przeliczonych
   * na wielkość opakowania wybranego leku), łącznie z wybranym lekiem.
   */
  sredniaCena: number;
  /** Liczba leków w grupie (łącznie z wybranym). */
  liczbaWGrupie: number;
  /** Dopłata za wybrany lek minus średnia w grupie (PLN; ujemna = wybrany lek tańszy od średniej). */
  roznicaDoSredniej: number;
}

export type DataSource = "parquet" | "fallback-demo";

export interface DataMeta {
  source: DataSource;
  /** Adres zasobu, z którego zbudowano dane (null dla próbki demo). */
  resource_url: string | null;
  resource_title: string | null;
  built_at: string;
  rows: number;
  /** Liczba leków refundowanych (Rp) w bazie. */
  rows_rp?: number;
  /** Liczba leków bez recepty (OTC) w bazie. */
  rows_otc?: number;
  /** Źródło leków OTC: „rpl” – Rejestr Produktów Leczniczych, „builtin” – wbudowany zestaw. */
  otc_source?: "rpl" | "builtin" | null;
}

export interface HealthStatus {
  status: "ok";
  version: string;
  rows: number;
  data: DataMeta;
  uptime_s: number;
  /** Maksymalny `limit` akceptowany przez `GET /api/search` (`SEARCH_MAX_LIMIT`). */
  search_max_limit: number;
}

/** Wynik zapytania wraz z czasem wykonania SQL w milisekundach. */
export interface Timed<T> {
  data: T;
  durationMs: number;
}
