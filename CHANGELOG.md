# Historia zmian

Wszystkie istotne zmiany w projekcie są dokumentowane w tym pliku.

Format oparty jest na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/),
a projekt stosuje [Semantic Versioning](https://semver.org/lang/pl/).

## [Unreleased]

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
