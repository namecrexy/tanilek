# Raport końcowy projektu TaniLek

## Metryka dokumentu (ISO 10013)

| Pole                            | Wartość                                                   |
|---------------------------------|-----------------------------------------------------------|
| **Identyfikator dokumentu**     | DOC-ISO21513-001                                          |
| **Tytuł**                       | Raport końcowy projektu TaniLek (struktura ISO 21513)     |
| **Wersja**                      | 1.2.0                                                     |
| **Autor**                       | Bartosz Pastuszka                                         |
| **Właściciel praw autorskich**  | Bartosz Pastuszka                                         |
| **Data utworzenia**             | 2026-11-22                                                |
| **Data ostatniej aktualizacji** | 2026-11-23                                                |
| **Status**                      | Zatwierdzony                                              |
| **Klasyfikacja**                | Publiczny (licencja MIT)                                  |
| **Dokumenty powiązane**         | DOC-PMI-LL-002, DOC-ARCH-003, `README.md`, `CHANGELOG.md` |

## Historia zmian

| Wersja | Data       | Autor                     | Opis zmian                  |
|--------|------------|---------------------------|-----------------------------|
| 1.0.0  | 2026-11-22 | Bartosz Pastuszka         | Pierwsze wydanie raportu.   |
| 1.1.0  | 2026-11-22 | Bartosz Pastuszka         | Wydanie 1.1.0: wyszukiwarka najbliższych aptek (OpenStreetMap), `Cache-Control: no-cache` dla plików statycznych, 189 testów. |
| 1.2.0  | 2026-11-23 | Bartosz Pastuszka         | Wydanie 1.2.0: leki bez recepty (OTC) z RPL, kody ATC i automatyczne opisy grup, średnia cena w grupie, filtr Rp/OTC, cache wyszukiwania, failover Overpass i tryb awaryjny aptek, paski postępu, 288 testów. |

> **Nota o strukturze.** Układ rozdziałów odpowiada szkieletowi raportu końcowego określonemu
> w wymaganiach projektu (oznaczenie „ISO 21513”). Treść realizuje zalecenia dotyczące
> zamknięcia projektu z rodziny norm ISO 21500 (w szczególności ISO 21502:2020): potwierdzenie
> dostarczenia produktów, porównanie z planem, ocena korzyści oraz przekazanie wiedzy.

---

## 1. Cel projektu i kontekst społeczny

### 1.1. Problem

Pacjenci – zwłaszcza seniorzy i osoby przewlekle chore – wykupują w aptece lek wskazany
na recepcie, często nie wiedząc, że w wykazie leków refundowanych Ministra Zdrowia istnieją
odpowiedniki o **tej samej substancji czynnej, dawce i postaci**, za które dopłata pacjenta
jest wielokrotnie niższa. Informacja ta jest publiczna, ale zapisana w obszernym arkuszu
(kilka tysięcy wierszy, kilkanaście kolumn), który nie nadaje się do samodzielnego
przeszukiwania przez pacjenta.

### 1.2. Cel główny

Udostępnienie bezpłatnego, otwartoźródłowego narzędzia, które w czasie rzeczywistym:

1. odnajduje lek po nazwie handlowej, substancji czynnej, wskazaniu lub kodzie EAN,
2. pokazuje wszystkie odpowiedniki z tej samej grupy, posortowane od najtańszego,
3. wylicza dokładną oszczędność w złotych i procentach względem wybranego leku.

### 1.3. Cele szczegółowe (mierzalne)

| ID  | Cel                                                                  | Miara sukcesu                           |
|-----|----------------------------------------------------------------------|-----------------------------------------|
| C1  | Szybkie wyszukiwanie                                                 | Czas zapytania DuckDB < 10 ms (p95)     |
| C2  | Lekki interfejs                                                      | Pobranie strony < 50 ms, brak bundlera  |
| C3  | Niezawodne uruchomienie                                              | Aplikacja startuje bez sieci (tryb demo)|
| C4  | Poprawność obliczeń                                                  | Testy automatyczne logiki oszczędności  |
| C5  | Łatwe wdrożenie                                                      | `docker compose up --build`             |
| C6  | Dokumentacja i otwartość                                             | Licencja MIT, CI, dokumenty w `docs/`   |

### 1.4. Interesariusze

| Interesariusz                        | Potrzeba                                                           |
|--------------------------------------|--------------------------------------------------------------------|
| Pacjenci, seniorzy, opiekunowie      | Prosta informacja: „czy istnieje tańszy odpowiednik i ile zaoszczędzę?” |
| Farmaceuci                           | Szybkie zestawienie grupy zamienników przy okienku                  |
| Organizacje pacjenckie, NGO          | Narzędzie do edukacji i samodzielnego wdrożenia                     |
| Społeczność open source              | Czytelny kod, testy, dokumentacja, łatwy start                     |

## 2. Osiągnięte rezultaty i produkty projektu

### 2.1. Produkty

| Produkt                       | Lokalizacja                       | Stan        |
|-------------------------------|-----------------------------------|-------------|
| Serwer HTTP + REST API        | `src/server.ts`                   | Dostarczony |
| Warstwa danych DuckDB         | `src/db.ts`                       | Dostarczony |
| Konfiguracja z walidacją      | `src/config.ts`, `.env.example`   | Dostarczony |
| Interfejs użytkownika         | `src/public/`                     | Dostarczony |
| Skrypt pobierania danych      | `scripts/fetch_data.ts`           | Dostarczony |
| Próbka danych (35 leków)      | `tests/fixtures/sample_leki.csv`  | Dostarczony |
| Wyszukiwarka aptek (OSM)      | `src/pharmacies.ts`               | Dostarczony (1.1.0), failover i tryb awaryjny (1.2.0) |
| Leki OTC i szacowanie cen     | `src/otc.ts`                      | Dostarczony (1.2.0) |
| Opisy grup ATC                | `src/atc.ts`                      | Dostarczony (1.2.0) |
| Cache wyszukiwania (LRU/TTL)  | `src/cache.ts`                    | Dostarczony (1.2.0) |
| Testy automatyczne (288)      | `tests/`                          | Dostarczony |
| Pipeline CI                   | `.github/workflows/ci.yml`        | Dostarczony |
| Obraz Docker i Compose        | `Dockerfile`, `docker-compose.yml`| Dostarczony |
| Dokumentacja                  | `README.md`, `docs/`, pliki społeczności | Dostarczony |

### 2.2. Funkcjonalność

- `GET /api/search` – wyszukiwanie z rankingiem (prefiks nazwy → prefiks substancji →
  pozostałe dopasowania), odporne na brak polskich znaków; każda pozycja zawiera liczbę
  zamienników i maksymalną możliwą oszczędność.
- `GET /api/equivalents` – pełna grupa zamienników z oszczędnością w PLN i %, z przeliczeniem
  dopłaty przy różnych wielkościach opakowań (np. 30 vs 60 tabletek).
- `GET /api/health` – stan aplikacji i informacja o źródle danych (pełny wykaz / tryb demo).
- `GET /api/pharmacies` (wersja 1.1.0) – maks. 8 najbliższych aptek dla kodu pocztowego lub adresu:
  geokodowanie OpenStreetMap Nominatim, apteki z Overpass API w promieniu 3 km (przy braku
  wyników 8 km), odległość wzorem Haversine'a, link do nawigacji, cache w pamięci 15 min;
  błędy `400` / `404` / `502` z komunikatami po polsku.
- Interfejs z podglądem metryk wydajności na żywo (czas DuckDB z nagłówka `Server-Timing`).
- **Wersja 1.2.0:** leki bez recepty (OTC) z Rejestru Produktów Leczniczych z orientacyjnymi cenami
  i filtrem „Wszystkie / Refundowane (NFZ) / Bez recepty (OTC)” z licznikami; średnia cena w każdej grupie
  zamienników z porównaniem do wybranego leku; karta „Na co pomaga” dla każdego leku (słownik 220 substancji
  lub automatyczny opis grupy ATC); `GET /api/search` z cache LRU/TTL 10 min i polami `cached` /
  `durationMs`; wyszukiwarka aptek z rotacją 3 serwerów Overpass (8 s na serwer) i trybem awaryjnym
  (`isFallback`) zamiast błędu `502`; animowane paski postępu w UI i w skrypcie ETL; wyszukiwarka aptek
  przeniesiona nad przewijaną tabelę zamienników.

### 2.3. Weryfikacja jakości

| Kontrola                         | Wynik                                         |
|----------------------------------|-----------------------------------------------|
| `bun test`                       | 288 testów, 1 582 asercje – 100% zaliczonych  |
| `bun run lint` (Biome)           | 0 błędów, 0 ostrzeżeń                         |
| `bun run typecheck` (TS strict)  | 0 błędów                                      |
| Import rzeczywistego wykazu MZ   | 4 282 leki (arkusz `A1`, obwieszczenie z 16.09.2026, obowiązuje od 1.10.2026), 1450 grup, 460 substancji |
| Słownik wyszukiwarki             | 220 substancji czynnych (w tym 45 OTC), 1 370 haseł; 75 grup ATC z opisami |
| Import leków OTC z RPL (1.2.0)   | 5 835 opakowań OTC z 23 030 produktów RPL; kody ATC uzupełnione dla 3 928 z 4 282 leków Rp; łącznie 10 117 pozycji |
| Karta „Na co pomaga” (1.2.0)     | 100% leków OTC i 96,8% leków Rp ze słownika lub grupy ATC (reszta – ze wskazania MZ) |
| Budowa Parquet z próbki          | 35 pozycji, kompresja ZSTD potwierdzona testem |

## 3. Porównanie realizacji z planem pierwotnym (zakres, harmonogram, wydajność)

### 3.1. Zakres

| Element planu                                          | Realizacja | Komentarz |
|--------------------------------------------------------|------------|-----------|
| Wyszukiwarka po nazwie, INN i wskazaniu                | Pełna, rozszerzona | Dodano wyszukiwanie po kodzie EAN i ignorowanie polskich znaków. |
| Grupowanie zamienników i oszczędność w PLN/%           | Pełna, rozszerzona | Dodano przeliczanie różnych wielkości opakowań. |
| Metryki `Server-Timing` w UI                           | Pełna      | Dodatkowo czas całkowity serwera i czas sieci. |
| Pobieranie danych z API dane.gov.pl                    | **Częściowa – odchylenie** | API działa i jest przeszukiwane, lecz aktualny wykaz MZ nie jest tam publikowany w formie tabelarycznej (zob. 3.4). Dodano `SOURCE_URL` i `DANE_GOV_DATASET_ID`. |
| Tryb awaryjny z próbki                                 | Pełna      | Dodatkowo samonaprawa uszkodzonego pliku Parquet przy starcie serwera. |
| Docker + Compose + HEALTHCHECK                         | Pełna      | Obraz nie był budowany lokalnie (brak Dockera na stacji roboczej) – weryfikację przeniesiono do zadania CI. |
| Biome, `bun test`, CI                                  | Pełna      | Dodano kontrolę typów TypeScript w CI. |
| Dokumentacja ISO 10013 / ISO 21513 / PMI               | Pełna      | — |

### 3.2. Harmonogram

| Etap                                              | Plan     | Realizacja |
|---------------------------------------------------|----------|------------|
| E1. Rozpoznanie źródła danych i technologii       | Etap 1   | Zrealizowany; wykryto brak wykazu MZ na dane.gov.pl. |
| E2. Warstwa danych i normalizacja                 | Etap 2   | Zrealizowany; dodatkowa iteracja po teście na rzeczywistym pliku XLSX. |
| E3. API HTTP i interfejs                          | Etap 3   | Zrealizowany zgodnie z planem. |
| E4. Testy, lint, CI                               | Etap 4   | Zrealizowany; 100% testów zaliczonych. |
| E5. Optymalizacja wydajności                      | Etap 4   | Zrealizowany; dodatkowa iteracja (materializacja) po pomiarach na pełnych danych. |
| E6. Docker i dokumentacja                         | Etap 5   | Zrealizowany. |

Wszystkie etapy zrealizowano w ramach jednej iteracji wydania 1.0.0 (2026-11-22).
W wydaniu 1.1.0 (2026-11-22) dodano wyszukiwarkę najbliższych aptek (`src/pharmacies.ts`,
26 nowych testów z zamockowanym `fetch`) oraz poprawiono nagłówki cache plików statycznych.
W wydaniu 1.2.0 (2026-11-23) dodano leki OTC z RPL, opisy grup ATC, średnie ceny w grupach, filtr
kategorii, cache wyszukiwania oraz failover i tryb awaryjny wyszukiwarki aptek (99 nowych testów).
Dwie nieplanowane iteracje (E2, E5) wynikały z decyzji o weryfikacji rozwiązania na
rzeczywistym wykazie MZ zamiast wyłącznie na próbce – zwiększyły nakład pracy, ale wykryły
trzy błędy, których testy na próbce by nie ujawniły (zob. DOC-PMI-LL-002).

### 3.3. Wydajność – cele a wyniki

| Cel                                    | Wartość docelowa | Wynik (4282 pozycje)         | Ocena |
|----------------------------------------|------------------|------------------------------|-------|
| Czas zapytania wyszukiwania (p95)      | < 10 ms          | 3,7 ms                       | ✅    |
| Czas zapytania zamienników (p95)       | < 10 ms          | 1,8 ms                       | ✅    |
| Pobranie strony (HTML/CSS/JS)          | < 50 ms          | 4–5 ms każdy plik (localhost)| ✅    |
| Redukcja rozmiaru CSV → Parquet        | 70–80%           | 87,9% (ZSTD), 82,2% (Snappy) | ✅    |
| Debouncing zapytań                     | 150 ms           | 150 ms                       | ✅    |
| Wyszukiwanie p95 – v1.2.0 (10 117 poz.) | < 10 ms         | 6,6 ms (z licznikami kategorii); z cache 0,04 ms | ✅ |
| Zamienniki p95 – v1.2.0                | < 10 ms          | 2,0 ms                       | ✅    |

### 3.4. Odchylenia i ich obsługa

| Odchylenie | Przyczyna | Działanie |
|------------|-----------|-----------|
| Brak aktualnego wykazu MZ na dane.gov.pl | Obwieszczenia publikowane są jako załączniki na gov.pl; na dane.gov.pl dostępny jest jedynie zbiór NFZ „Leki refundowane” z zestawieniami z lat 2011–2018. | Skrypt przeszukuje API, waliduje strukturę i odrzuca niepasujące pliki; dodano `SOURCE_URL`. Import rzeczywistego załącznika XLSX (obwieszczenie na 1.10.2026) został zweryfikowany: 4282 pozycje. |
| Nieprzetestowany lokalnie obraz Docker | Brak Dockera na stacji roboczej | Zadanie `docker` w CI buduje obraz i wykonuje smoke test API. |
| Wydajność wersji wstępnej ok. 13 ms | Widok nad Parquet + złączenie przy każdym zapytaniu | Materializacja w pamięci z kolumnami wyliczonymi z góry: 3,1 ms (p50). |
| RPL nie zawiera cen leków OTC (1.2.0) | Rejestr opisuje pozwolenia i opakowania, nie ceny; ceny OTC nie są regulowane | Ceny szacowane (znana cena marki lub typowa cena grupy ATC), wyraźnie oznaczane „ok.” z linkami do KtoMaLek / GdziePoLek; opakowania bez kodu ATC pomijane. |
| Arkusz A1 obwieszczenia nie ma kodów ATC (1.2.0) | Format obwieszczenia MZ | Kody ATC uzupełniane z RPL po kodzie EAN (3 928 z 4 282). |
| Jednoczesna awaria wszystkich serwerów Overpass (1.2.0) | Przeciążenie publicznej infrastruktury OSM (w testach 23.11.2026: `502`/`504`/timeout na wszystkich 3) | Tryb awaryjny z przykładowymi, wyraźnie oznaczonymi aptekami i linkiem do Map Google zamiast błędu. |

## 4. Wpływ społeczny i techniczny rozwiązania

### 4.1. Wpływ społeczny

Analiza rzeczywistego wykazu (obwieszczenie na 1 października 2026 r.) przeprowadzona
narzędziem TaniLek:

| Wskaźnik                                                        | Wartość        |
|-----------------------------------------------------------------|----------------|
| Pozycje w wykazie (apteka, arkusz A1)                           | 4 282          |
| Grupy (substancja + dawka + postać)                             | 1450           |
| Grupy z co najmniej dwoma odpowiednikami                        | 727            |
| Pozycje, dla których istnieje odpowiednik                       | 3559 (83,1%)   |
| Pozycje, dla których istnieje **tańszy** odpowiednik            | 2615 (61,1%)   |
| Mediana możliwej oszczędności na opakowaniu                     | 2,53 zł        |
| Średnia możliwa oszczędność na opakowaniu                       | 5,46 zł        |
| Pozycje z możliwą oszczędnością ≥ 10 zł na opakowaniu           | 324            |
| Przykład: Eliquis 5 mg, 56 tabl. powl. (dopłata 200,06 zł)      | do 184,56 zł (92,3%) |

Dla pacjenta przewlekle chorego, który co miesiąc wykupuje kilka leków, różnica rzędu
kilku–kilkudziesięciu złotych na opakowaniu daje istotną kwotę w skali roku. Wskaźniki
powyżej opisują **potencjał** wynikający z danych, a nie zmierzone oszczędności użytkowników –
te wymagałyby badania z udziałem pacjentów.

Rozwiązanie świadomie **nie zastępuje** farmaceuty ani lekarza: interfejs przypomina
o adnotacji „nie zamieniać” (NZ) na recepcie i o konsultacji przed zmianą leku, a za zamiennik
uznaje wyłącznie lek o tej samej postaci farmaceutycznej.

Dostępność: duża czcionka bazowa (18 px), kontrast zgodny z WCAG 2.1 AA, tryb ciemny,
pełna obsługa klawiatury, komunikaty dla czytników ekranu (`aria-live`), wyszukiwanie
bez polskich znaków.

### 4.2. Wpływ techniczny

- Wzorzec „otwarte dane → Parquet → DuckDB in-process” pokazuje, że analityczna wyszukiwarka
  nie wymaga osobnego serwera bazy danych: cały system to jeden proces i plik ~108 KB.
- Odporna normalizacja (wykrywanie nagłówka, mapowanie kolumn po treści) jest wielokrotnego
  użytku dla innych publikacji urzędowych w XLSX/CSV.
- Projekt może służyć jako materiał edukacyjny: testy, CI, Docker, nagłówki HTTP wydajności.

## 5. Wnioski końcowe i dalszy rozwój

### 5.1. Wnioski

1. Cele C1–C6 zostały osiągnięte; cele wydajnościowe przekroczone z dużym zapasem.
2. Największym ryzykiem projektu okazała się **dostępność i stabilność formatu danych źródłowych**,
   a nie technologia. Weryfikacja na rzeczywistym pliku była kluczowa.
3. Architektura z trybem demo zapewnia, że aplikacja działa „od strzału” w każdym środowisku.

### 5.2. Rekomendowane kierunki rozwoju

| Priorytet | Kierunek                                                                                   |
|-----------|--------------------------------------------------------------------------------------------|
| Wysoki    | Automatyczne wykrywanie najnowszego obwieszczenia na gov.pl lub wniosek do MZ o publikację wykazu na dane.gov.pl (format CSV/API). |
| Wysoki    | Uwzględnienie uprawnień dodatkowych (leki bezpłatne „S” dla seniorów 65+, „DZ” dla dzieci). |
| Średni    | Rozpoznawanie objętości i liczby jednostek dla płynów, zawiesin i wstrzykiwaczy.           |
| Średni    | Historia cen między kolejnymi obwieszczeniami i powiadomienia o zmianach dopłat.           |
| Średni    | Test użyteczności z udziałem seniorów i farmaceutów.                                       |
| Średni    | Własna instancja Overpass API dla wyszukiwarki aptek – 3 publiczne serwery lustrzane (1.2.0) bywają przeciążone jednocześnie. |
| Średni    | Rzeczywiste ceny leków OTC (np. współpraca z serwisami porównującymi ceny) zamiast szacunku.  |
| Niski     | Tryb offline (PWA) i wersja do druku dla pacjenta.                                         |

### 5.3. Przekazanie projektu

Repozytorium zawiera komplet informacji potrzebnych do utrzymania: instrukcję uruchomienia
(`README.md`), zasady współpracy (`CONTRIBUTING.md`), historię zmian (`CHANGELOG.md`),
opis architektury (DOC-ARCH-003) oraz wnioski z realizacji (DOC-PMI-LL-002).
