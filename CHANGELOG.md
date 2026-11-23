# Historia zmian

Wszystkie istotne zmiany w projekcie są dokumentowane w tym pliku.

Format oparty jest na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/),
a projekt stosuje [Semantic Versioning](https://semver.org/lang/pl/).

## [Unreleased]

### Dodano

- Wyszukiwanie po objawach: zapytanie przeszukuje także opis „Na co pomaga” (słownik substancji / grupa ATC)
  i wskazanie refundacyjne, więc „katar”, „zgaga”, „gorączka” czy „ból gardła” zwracają pasujące leki.
  Słowa objawu są porównywane po rdzeniu (odcięte polskie końcówki, np. „gorączka” → „obniża gorączkę”),
  a wszystkie słowa muszą wystąpić w opisie.
- Pole `dopasowanie` w wynikach `GET /api/search` (`nazwa` | `alias` | `substancja` | `objawy` | `przyblizone`).
- Przycisk „Pokaż więcej wyników” pod listą wyników: widoczny, gdy łączna liczba dopasowań w bazie
  jest większa niż liczba pobranych opakowań; każde kliknięcie zwiększa `limit` o 30 (30 → 60 → 90…),
  a status pokazuje np. „Wyświetlono 17 pozycji (30 z 404 opakowań)”.
- Pole `search_max_limit` w `GET /api/health` (interfejs nie prosi o więcej wyników, niż pozwala serwer).

### Zmieniono

- Domyślny `SEARCH_MAX_LIMIT` podniesiony z 50 do 500, aby „Pokaż więcej wyników” mógł pobrać więcej niż 50 opakowań.
- Jeden wspólny ranking zamiast kolejnych etapów: na górze dokładne trafienia nazwy leku, kodu EAN lub
  aliasu, niżej substancja czynna i opis objawów, a na końcu wyniki przybliżone (Jaro-Winkler) – także
  wtedy, gdy są dokładne trafienia. Wyszukiwanie to jedno zapytanie DuckDB (liczniki kategorii
  funkcjami okna); `matchMode` opisuje najlepsze trafienie.

## [1.2.0] - 2026-11-23

### Dodano

- **Leki bez recepty (OTC)** z Rejestru Produktów Leczniczych (eksport CSV RPL, zmienna `RPL_CSV_URL`):
  opakowania z kategorią dostępności `OTC` (ludzkie, ze ważnym pozwoleniem, bez skasowanych) trafiają do
  bazy obok leków refundowanych. Pełna baza: **4 282 leki Rp + 5 835 opakowań OTC = 10 117 pozycji**.
  Ceny OTC są orientacyjne (RPL nie zawiera cen): szacowane ze znanej ceny tej samej marki i dawki
  z wbudowanego zestawu albo z typowej ceny w grupie ATC, skalowane wielkością opakowania.
- Wbudowany zestaw 38 popularnych leków OTC (m.in. Apap, Ibuprom, Nurofen, Rutinoscorbin, Strepsils, Espumisan,
  Voltaren, Rennie, Stoperan, Neo-Angin) ze średnimi cenami rynkowymi – używany, gdy RPL jest niedostępny,
  oraz w trybie demo, więc funkcja OTC działa od razu.
- Nowe pola leku: `kategoriaDostepnosci` (`"Rp" | "OTC"`), `czyRefundowany`, `kodAtc`. Kody ATC leków
  refundowanych są uzupełniane z RPL po kodzie EAN (3 928 z 4 282 leków Rp).
- Średnia cena w grupie zamienników: `sredniaCena` i `liczbaWGrupie` przy każdym wyniku wyszukiwania,
  a w `GET /api/equivalents` także `roznicaDoSredniej`; boks „Średnia cena w grupie: … — wybrany lek jest
  o … tańszy/droższy od średniej” w panelu zamienników.
- Filtr kategorii `GET /api/search?kategoria=wszystkie|Rp|OTC` z licznikami `liczniki` oraz przełącznik
  „Wszystkie / Refundowane (NFZ) / Bez recepty (OTC)” z liczbą pozycji w każdej kategorii.
- Etykieta „Bez recepty (OTC)”, ceny „ok. …”, informacja o nieregulowanych cenach OTC i linki KtoMaLek /
  GdziePoLek dla leków bez recepty.
- Słownik substancji rozszerzony o 45 substancji OTC (m.in. ksylometazolina, oksymetazolina, symetykon,
  butamirat, benzydamina, salicylan choliny, flurbiprofen, Rennie, diosmina, dimetynden, kwas askorbinowy,
  mleczan magnezu) z opisami „Na co pomaga / Jak stosować” i polskimi aliasami handlowymi.
- Moduł `src/atc.ts`: opisy 75 grup ATC (m.in. `N02B`, `M01A`, `R01A`, `R02A`, `R05C`, `R05D`, `R06A`,
  `A02A`/`A02B`, `A07`, `C05`, `D01`, `D07`, `S01`, `A11`/`A12`) z dopasowaniem najdłuższego prefiksu –
  automatyczna karta informacyjna dla leków spoza słownika (wszystkie leki OTC mają opis ze słownika lub ATC).
- Pamięć podręczna `GET /api/search` (LRU, TTL 10 min, `src/cache.ts`) oraz pola `cached` i `durationMs`
  w odpowiedziach `GET /api/search` i `GET /api/pharmacies`; pigułka „⚡ Z pamięci podręcznej (2 ms)” /
  „🌐 Pobrano na żywo (140 ms)” / „⚠️ Tryb awaryjny” przy wynikach.
- Animowany pasek postępu z procentami i opisem etapu przy wyszukiwaniu aptek i leków
  (`25% — Wyszukiwanie współrzędnych adresu…` → `65% — Pobieranie aptek z OpenStreetMap…` → `100% — Gotowe`).
- Pasek postępu pobierania w skrypcie ETL: `[████░░░░░░] 42% · 1.8 MB / 4.3 MB`.
- 99 nowych testów (`tests/otc.test.ts`, `tests/etl-v12.test.ts`, rozszerzone `api` i `pharmacies`) –
  łącznie 288 testów.

### Zmieniono

- Wyszukiwarka aptek: rotacja 3 serwerów lustrzanych Overpass (`overpass-api.de`, `overpass.kumi.systems`,
  `maps.mail.ru`) z limitem 8 s na serwer i nagłówkiem `[out:json][timeout:10];`; serwer, który odpowiedział,
  jest odpytywany jako pierwszy w kolejnych zapytaniach.
- Tryb awaryjny aptek: gdy adres znaleziono, a wszystkie serwery Overpass zawiodły, API zwraca przykładowe
  apteki w okolicy (dystans Haversine'a, `isFallback: true`, link do wyszukiwania aptek w Mapach Google)
  zamiast błędu `502` (wyłączane `fallbackOnOverpassError: false` / `pharmacyFallback: false`).
  Wyniki trybu awaryjnego nie są zapisywane w cache.
- Sekcja „Znajdź aptekę w pobliżu” przeniesiona nad tabelę zamienników (pod boks „Najtańsza opcja”),
  zwarty formularz w jednym wierszu, zwijana lista aptek bezpośrednio pod formularzem.
- Tabela zamienników przewijana wewnątrz kontenera (`max-height: 340px`) z przyklejonym nagłówkiem
  (`thead th { position: sticky; top: 0 }`).
- Grupy zamienników nie łączą leków Rp i OTC (cena urzędowa nie jest porównywana z szacunkiem rynkowym).
- `ETag` odpowiedzi API liczony bez pól diagnostycznych (`cached`, `durationMs`) – `304 Not Modified` działa
  także dla wyników z pamięci podręcznej.
- `bun run fetch-data`: gdy wykaz MZ jest niedostępny, a istniejący `data/leki.parquet` zawiera pełny wykaz,
  dotychczasowe leki Rp są zachowywane (zamiast przejścia w tryb demo); pliki pobierane z
  `Accept-Encoding: identity`, aby pasek postępu znał rzeczywisty rozmiar.
- Plik Parquet z v1.1.0 (bez nowych kolumn) jest nadal czytany – brakujące kolumny mają wartości domyślne.

### Naprawiono

- Alias „Laremid” kierował do nieistniejącej substancji „Laremidum” zamiast do Loperamidum.

## [1.1.0] - 2026-11-22

### Dodano

- Moduł `src/pharmacies.ts` – wyszukiwarka najbliższych aptek po kodzie pocztowym lub adresie:
  geokodowanie OpenStreetMap Nominatim (Polska), apteki z Overpass API (`node` i `way`,
  `out center tags`) w promieniu 3 km z automatycznym rozszerzeniem do 8 km, odległość wzorem
  Haversine'a, maks. 8 wyników z linkiem do nawigacji Google Maps, cache w pamięci (TTL 15 min).
- Endpoint `GET /api/pharmacies?q=...` (walidacja 3–120 znaków → `400`, nieznany adres → `404`,
  awaria OpenStreetMap → `502` z komunikatem po polsku).
- Karta „Znajdź aptekę w pobliżu” w panelu zamienników: pole kodu/adresu zapamiętywane
  w `localStorage` (`tanilek_location`), dystans w pigułce (`350 m` / `1,4 km`), adres, godziny
  otwarcia, przycisk „Nawiguj”, informacja o jednakowej cenie leku refundowanego w każdej aptece
  oraz linki do KtoMaLek / GdziePoLek z nazwą wybranego leku.
- 26 nowych testów (`tests/pharmacies.test.ts`) z zamockowanym `fetch` – łącznie 189 testów.

### Zmieniono

- `app.js` i `styles.css` serwowane z `Cache-Control: no-cache` (wcześniej `max-age=3600`)
  i walidacją `ETag`; odwołania w `index.html` z parametrem `?v=1.1.0` – zwykłe F5 zawsze
  pobiera najnowszy interfejs.
- `idleTimeout` serwera zwiększony do 120 s, bo publiczne Overpass API potrafi odpowiadać ~30 s.

## [1.0.0] - 2026-11-22

### Dodano

- Wyszukiwarka leków refundowanych po nazwie handlowej, substancji czynnej (INN), wskazaniu
  i kodzie EAN/GTIN, odporna na brak polskich znaków („nadcisnienie” → „Nadciśnienie”).
- Grupowanie zamienników o tej samej substancji czynnej, dawce i postaci, sortowanie od najniższej
  dopłaty pacjenta oraz wyliczanie oszczędności w PLN i % (obliczenia w groszach).
- Przeliczanie dopłaty przy różnych wielkościach opakowań (np. 30 vs 60 tabletek).
- Endpointy REST: `GET /api/search`, `GET /api/equivalents`, `GET /api/health`.
- Nagłówki `Server-Timing` (czas zapytania DuckDB z dokładnością do µs), `ETag` z obsługą
  `304 Not Modified`, `Cache-Control` oraz nagłówki bezpieczeństwa (CSP, `nosniff`).
- Interfejs w czystym HTML/CSS/JS: debouncing 150 ms, anulowanie nieaktualnych zapytań,
  podgląd metryk wydajności na żywo, wysoki kontrast, tryb ciemny, obsługa klawiatury.
- Skrypt `scripts/fetch_data.ts`: wyszukiwanie zasobów w API dane.gov.pl, obsługa CSV i XLSX,
  automatyczne wykrywanie wiersza nagłówka, normalizacja formatu obwieszczenia MZ
  („Nazwa, postać, dawka”, kwoty „12,50 zł”, GTIN-14), kodowania UTF-8 i Windows-1250.
- Zmienne `SOURCE_URL` i `DANE_GOV_DATASET_ID` do wskazania konkretnego źródła danych.
- Zapis danych do Apache Parquet z kompresją ZSTD; atomowa podmiana pliku.
- Tryb awaryjny: brak sieci, błąd API lub zmiana formatu → automatyczna baza demo
  z `tests/fixtures/sample_leki.csv` (35 leków); samonaprawa uszkodzonego pliku Parquet.
- Materializacja danych w pamięci DuckDB przy starcie z wyliczonymi z góry kluczami grup
  i oszczędnościami; pula połączeń i cache przygotowanych zapytań.
- 163 testy (`bun test`): logika oszczędności, normalizacja, zapytania DuckDB, endpointy HTTP,
  walidacja konfiguracji.
- Biome (lint + formatowanie), TypeScript strict, pipeline GitHub Actions (lint, typy, testy,
  budowa i smoke test obrazu Docker).
- Wieloetapowy `Dockerfile` (oven/bun slim, użytkownik bez uprawnień root, `HEALTHCHECK`)
  i `docker-compose.yml`.
- Dokumentacja: README, raport końcowy ISO 21513, Lessons Learned wg PMI, opis architektury
  i wydajności (metryki dokumentów wg ISO 10013).
