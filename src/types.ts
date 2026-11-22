/**
 * Wspólne typy domenowe aplikacji TaniLek.
 * Nazwy pól odpowiadają znormalizowanym kolumnom pliku `data/leki.parquet`.
 */

/** Pojedyncza pozycja wykazu leków refundowanych (jedno opakowanie, jeden kod EAN). */
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
  /** Zakres wskazań objętych refundacją. */
  wskazanie: string;
}

/** Pozycja wyniku wyszukiwania wzbogacona o informacje o grupie zamienników. */
export interface SearchHit extends DrugRecord {
  /** Liczba innych leków z tą samą substancją czynną, dawką i postacią. */
  liczba_zamiennikow: number;
  /** Najniższa dopłata pacjenta w grupie zamienników (PLN). */
  najnizsza_doplata_w_grupie: number;
  /** Maksymalna możliwa oszczędność na opakowaniu względem tego leku (PLN, ≥ 0). */
  mozliwa_oszczednosc: number;
}

/**
 * Sposób dopasowania wyników:
 *  - „direct” – bezpośrednie dopasowanie nazwy, substancji, wskazania lub EAN,
 *  - „alias” – zapytanie przetłumaczone słownikiem marek / polskich nazw (np. apap → Paracetamolum),
 *  - „fuzzy” – wyniki przybliżone (literówka) wg podobieństwa Jaro-Winklera.
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
   *  - „ogolny” – opis zastępczy wygenerowany z pól `wskazanie` i `postac` (rzadka substancja).
   */
  zrodlo: "slownik" | "ogolny";
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
}

export type DataSource = "parquet" | "fallback-demo";

export interface DataMeta {
  source: DataSource;
  /** Adres zasobu, z którego zbudowano dane (null dla próbki demo). */
  resource_url: string | null;
  resource_title: string | null;
  built_at: string;
  rows: number;
}

export interface HealthStatus {
  status: "ok";
  version: string;
  rows: number;
  data: DataMeta;
  uptime_s: number;
}

/** Wynik zapytania wraz z czasem wykonania SQL w milisekundach. */
export interface Timed<T> {
  data: T;
  durationMs: number;
}
