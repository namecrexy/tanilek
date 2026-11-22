# TaniLek 💊

**Wyszukiwarka tańszych zamienników leków refundowanych** – ten sam lek, ta sama dawka,
często kilka razy taniej.

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
![Licencja: MIT](https://img.shields.io/badge/licencja-MIT-blue.svg)
![Bun](https://img.shields.io/badge/runtime-Bun-black)
![DuckDB](https://img.shields.io/badge/silnik-DuckDB-yellow)

---

## Czym jest projekt i jaki problem rozwiązuje

Pacjenci – zwłaszcza seniorzy i osoby przewlekle chore – często wykupują drogi lek oryginalny,
nie wiedząc, że w wykazie leków refundowanych Ministra Zdrowia są odpowiedniki z **tą samą
substancją czynną, dawką i postacią**, za które dopłata jest wielokrotnie niższa
(np. 3,20 zł zamiast 85,00 zł).

TaniLek:

1. **wyszukuje** leki po nazwie handlowej, substancji czynnej (INN), wskazaniu lub kodzie EAN –
   także bez polskich znaków („nadcisnienie” znajdzie „Nadciśnienie”),
2. **grupuje zamienniki** o tej samej substancji, dawce i postaci i sortuje je od najtańszego,
3. **wylicza oszczędność** w złotych i procentach względem wybranego leku – z przeliczeniem,
   gdy opakowania mają różną liczbę tabletek (np. 30 vs 60),
4. **pokazuje wydajność na żywo** – czas zapytania DuckDB z nagłówka HTTP `Server-Timing`,
5. **znajduje najbliższe apteki** po kodzie pocztowym lub adresie (OpenStreetMap: Nominatim +
   Overpass API) – z odległością, godzinami otwarcia i przyciskiem „Nawiguj” (od wersji 1.1.0).

W rzeczywistym wykazie (obwieszczenie na 1.10.2026, 4282 pozycje) **61% pozycji ma tańszy
odpowiednik**; przykładowo dla Eliquis 5 mg (56 tabl.) różnica dopłaty sięga 184,56 zł.

| Metryka | Wartość |
|---------|---------|
| Baza danych | **4 282 leki** z arkusza `A1` obwieszczenia Ministra Zdrowia z 16 września 2026 r. (obowiązującego od 1 października 2026 r.) |
| Słownik wyszukiwarki | **180 substancji czynnych i 1 154 aliasy** (nazwy handlowe, polskie nazwy i opisy stosowania) |
| Testy automatyczne | **189 testów** (`bun test`, 997 asercji) |

> ⚠️ **TaniLek nie jest wyrobem medycznym i nie zastępuje porady lekarza ani farmaceuty.**
> Zamiana w aptece nie jest możliwa, jeśli lekarz oznaczył receptę „nie zamieniać” (NZ).

## Źródło danych (dane.gov.pl)

- Aplikacja korzysta z publicznego **API portalu [dane.gov.pl](https://dane.gov.pl)**
  (`https://api.dane.gov.pl/1.4/`), wyszukując zbiory dotyczące leków refundowanych
  i pobierając najnowszy zasób CSV/XLSX.
- Docelowym źródłem jest *Obwieszczenie Ministra Zdrowia w sprawie wykazu refundowanych leków,
  środków spożywczych specjalnego przeznaczenia żywieniowego oraz wyrobów medycznych*.
- **Ważne (stan na 2026-11-22):** aktualny wykaz MZ **nie jest publikowany na dane.gov.pl**
  w formie tabelarycznej – dostępny jest tam jedynie zbiór NFZ „Leki refundowane” z zestawieniami
  z lat 2011–2018, który nie zawiera dopłat pacjenta. Skrypt rozpoznaje to automatycznie
  (walidacja kolumn) i automatycznie pobiera arkusz `A1` z załącznika XLSX najnowszego obwieszczenia
  ze strony
  [gov.pl/web/zdrowie](https://www.gov.pl/web/zdrowie/obwieszczenia-ministra-zdrowia-lista-lekow-refundowanych)
  (konkretny plik można też wskazać w `SOURCE_URL`, zob. [Aktualizacja danych](#aktualizacja-danych-z-api-bun-run-fetch-data)).
  Dopiero gdy i to się nie uda, skrypt przechodzi w tryb demo. Aktualna baza: **4 282 leki**
  z arkusza `A1` obwieszczenia z 16 września 2026 r. (obowiązującego od 1 października 2026 r.),
  import w ok. 1 s.
- Bez dostępu do sieci aplikacja **zawsze** startuje jako działające demo z próbki
  `tests/fixtures/sample_leki.csv` (35 leków, **ceny orientacyjne – nie są to oficjalne dane**).

## Architektura i optymalizacja wydajności

```
dane.gov.pl / SOURCE_URL ──► scripts/fetch_data.ts ──► data/leki.parquet (ZSTD)
        (CSV / XLSX)          (normalizacja w DuckDB)          │
                                                               ▼
przeglądarka ◄── JSON + Server-Timing + ETag ◄── Bun.serve ◄── DuckDB in-memory
(HTML/CSS/JS)                                   (src/server.ts)  (widok + tabela)
```

| Technika | Efekt (zmierzony na 4282 pozycjach) |
|----------|-------------------------------------|
| **Apache Parquet + ZSTD** zamiast CSV, odczyt tylko potrzebnych kolumn | 888 KB → 108 KB (**−87,9%**; Snappy −82,2%) |
| **Widok `VIEW` nad Parquet tworzony raz przy starcie** + materializacja w pamięci z kolumnami wyliczonymi z góry (tekst bez diakrytyków, klucz grupy, oszczędności) | wyszukiwanie p50 12,7 → **3,1 ms**, zamienniki 6,9 → **1,5 ms** |
| **Parametryzowane zapytania** (cache przygotowanych instrukcji, pula połączeń), filtrowanie `ILIKE` + `LIMIT` | brak SQL injection, stały plan zapytania |
| **`Server-Timing`, `ETag`, `Cache-Control`** | czas DuckDB w µs widoczny w UI; `304 Not Modified` dla powtórzeń |
| **Frontend bez frameworka i bundlera**, pliki w pamięci serwera, debouncing 150 ms | HTML/CSS/JS 4–5 ms każdy (localhost) |

> Uczciwie o `ILIKE`: wzorce `'%fraza%'` nie korzystają z indeksów (w żadnej bazie z indeksem
> B-drzewa/ART). Szybkość daje wektoryzowany skan kolumnowy danych w pamięci DuckDB.

Szczegóły: [docs/architektura-i-wydajnosc.md](docs/architektura-i-wydajnosc.md).

### API

| Metoda i ścieżka                       | Opis |
|----------------------------------------|------|
| `GET /api/search?q=sortis&limit=20`    | Wyszukiwanie (q: 2–100 znaków, limit: 1–`SEARCH_MAX_LIMIT`). Każdy wynik zawiera `liczba_zamiennikow` i `mozliwa_oszczednosc`. |
| `GET /api/equivalents?id=1`            | Grupa zamienników z `oszczednosc_pln`, `oszczednosc_proc`, `doplata_porownawcza` oraz `najlepsza_oferta`. |
| `GET /api/health`                      | Stan aplikacji, liczba pozycji i źródło danych (`parquet` / `fallback-demo`). |
| `GET /api/pharmacies?q=00-001`         | Maks. 8 najbliższych aptek (q: 3–120 znaków – kod pocztowy lub adres). Zwraca `{ query, resolvedLocation, radiusMeters, pharmacies }`; promień 3 km, a przy braku aptek 8 km. Kody błędów: `400` (walidacja), `404` (nieznany adres), `502` (awaria OpenStreetMap). |

```bash
curl -i "http://localhost:3000/api/search?q=sortis"
# Server-Timing: db;dur=2.552;desc="DuckDB query", total;dur=5.295;desc="Request total"
```

### Wyszukiwarka najbliższych aptek (`src/pharmacies.ts`)

W prawym panelu, pod tabelą zamienników (i już przed wyborem leku), znajduje się karta
**„Znajdź aptekę w pobliżu”**. Po wpisaniu kodu pocztowego lub adresu:

1. adres jest geokodowany przez **OpenStreetMap Nominatim** (tylko Polska, nagłówek
   `User-Agent: TaniLek/1.1.0 (open-source pharmacy finder)` zgodnie z polityką OSM),
2. apteki (`amenity=pharmacy`, punkty i obrysy budynków) pobierane są z **Overpass API**
   w promieniu 3 km, a gdy nic nie ma w pobliżu – automatycznie w promieniu 8 km,
3. serwer liczy odległość w linii prostej (wzór Haversine'a), sortuje i zwraca maks. 8 aptek
   z adresem, godzinami otwarcia, telefonem i linkiem „Nawiguj” (Google Maps),
4. wyniki trzymane są w cache w pamięci przez 15 minut, aby nie obciążać publicznych serwerów OSM.

Ostatni adres zapisywany jest w `localStorage` (`tanilek_location`), więc lista aptek zostaje
po przełączeniu leku i po odświeżeniu strony. Karta przypomina, że cena leku refundowanego jest
ustawowo taka sama w każdej aptece, i linkuje do KtoMaLek / GdziePoLek z nazwą wybranego leku.

> Publiczne Overpass API bywa przeciążone – odpowiedź może trwać kilkadziesiąt sekund
> (limit zapytania: 35 s), a przy awarii endpoint zwraca `502` z komunikatem po polsku.

Pliki statyczne (`index.html`, `app.js`, `styles.css`) mają `Cache-Control: no-cache` + `ETag`,
a odwołania w HTML zawierają `?v=1.1.0` – zwykłe odświeżenie (F5) zawsze pobiera aktualny interfejs.

## Szybki start z Dockerem (`docker compose up --build`)

```bash
docker compose up --build
```

Otwórz **http://localhost:3000**. Podczas budowy obraz próbuje pobrać dane; bez dostępu
do sieci automatycznie używa próbki demo. Warianty:

```bash
FETCH_MODE=demo docker compose up --build            # bez sieci, tylko próbka
SOURCE_URL="https://www.gov.pl/attachment/<id>" docker compose up --build   # pełny wykaz MZ
HOST_PORT=8080 docker compose up --build              # inny port na hoście
```

Obraz: wieloetapowy (`oven/bun:1-slim`), działa jako użytkownik bez uprawnień root,
ma `HEALTHCHECK` na `/api/health`.

## Uruchomienie lokalne (Bun)

Wymagania: [Bun](https://bun.sh) ≥ 1.1 (Windows, Linux, macOS).

```bash
bun install
cp .env.example .env      # opcjonalnie – wartości domyślne działają bez pliku .env
bun run dev               # tryb deweloperski z przeładowaniem: http://localhost:3000
# lub
bun run start             # tryb produkcyjny
```

Przy pierwszym starcie, jeśli `data/leki.parquet` nie istnieje, serwer sam zbuduje go z próbki.

| Polecenie                 | Działanie |
|---------------------------|-----------|
| `bun run dev`             | Serwer z automatycznym przeładowaniem |
| `bun run start`           | Serwer produkcyjny |
| `bun run fetch-data`      | Pobranie wykazu (API / `SOURCE_URL`) → `data/leki.parquet` |
| `bun run build-demo-data` | Zbudowanie `data/leki.parquet` z próbki, bez sieci |
| `bun test`                | Testy jednostkowe i integracyjne (189) |
| `bun run lint`            | Biome: lint + formatowanie (`lint:fix` naprawia) |
| `bun run typecheck`       | TypeScript strict |

## Aktualizacja danych z API (`bun run fetch-data`)

```bash
bun run fetch-data                 # wyszukiwanie w API dane.gov.pl; w razie problemów tryb demo
bun run fetch-data -- --strict     # kod błędu zamiast trybu demo (do automatyzacji)
bun run fetch-data -- --demo       # tylko próbka, bez sieci
```

Kolejność wyboru źródła:

1. **`SOURCE_URL`** – bezpośredni adres pliku CSV/XLSX, np. załącznika „zalacznik do obwieszczenia”
   (XLSX) z najnowszego obwieszczenia na gov.pl,
2. **`DANE_GOV_DATASET_ID`** – identyfikator konkretnego zbioru na dane.gov.pl,
3. wyszukiwanie w katalogu dane.gov.pl kolejno frazami z **`DANE_GOV_SEARCH_QUERY`** (rozdzielone `|`);
   brane są tylko zbiory z „wykaz”/„obwieszczenie” w tytule, bez zestawień „Wartość refundacji”,
   a zasoby – od najnowszej daty publikacji. Pliki XLSX są konwertowane do CSV (pierwszy arkusz z tabelą leków),
4. gdy dane.gov.pl nie dostarczy wykazu – załącznik XLSX „zalacznik do obwieszczenia” z najnowszego obwieszczenia
   na stronie **`MZ_OBWIESZCZENIA_URL`** (gov.pl; wczytywany jest arkusz „A1” – leki dostępne w aptece na receptę).

Skrypt sam wykrywa wiersz nagłówka i mapuje kolumny po ich treści (np. „Nazwa postać i dawka”,
„Numer GTIN…”, „Wysokość dopłaty świadczeniobiorcy”), obsługuje kwoty w formacie „12,50 zł”
oraz kodowania UTF-8 i Windows-1250. Plik jest podmieniany atomowo; po aktualizacji
zrestartuj serwer.

### Zmienne środowiskowe

| Zmienna                 | Domyślnie                              | Opis |
|-------------------------|----------------------------------------|------|
| `PORT`                  | `3000`                                 | Port HTTP |
| `NODE_ENV`              | `development`                          | `development` / `production` / `test` |
| `DATA_FILE_PATH`        | `./data/leki.parquet`                  | Plik bazy Parquet |
| `FALLBACK_CSV_PATH`     | `./tests/fixtures/sample_leki.csv`     | Próbka trybu demo |
| `DANE_GOV_API_BASE`     | `https://api.dane.gov.pl/1.4`          | Bazowy adres API |
| `DANE_GOV_SEARCH_QUERY` | `wykaz refundowanych leków\|obwieszczenie Ministra Zdrowia w sprawie wykazu refundowanych leków` | Frazy wyszukiwania zbioru (rozdzielone `\|`) |
| `DANE_GOV_DATASET_ID`   | —                                      | Konkretny zbiór na dane.gov.pl |
| `SOURCE_URL`            | —                                      | Bezpośredni plik CSV/XLSX (najwyższy priorytet) |
| `MZ_OBWIESZCZENIA_URL` | strona obwieszczeń MZ na gov.pl | Źródło zapasowe (XLSX najnowszego obwieszczenia); `off` wyłącza |
| `FETCH_TIMEOUT_MS`      | `30000`                                | Limit czasu żądań API |
| `SEARCH_DEFAULT_LIMIT`  | `20`                                   | Domyślna liczba wyników |
| `SEARCH_MAX_LIMIT`      | `50`                                   | Maksymalna liczba wyników |
| `API_CACHE_MAX_AGE`     | `60`                                   | `Cache-Control: max-age` odpowiedzi API (s) |

Błędna wartość kończy start czytelnym komunikatem (`[config] PORT musi być liczbą całkowitą…`).

## Struktura dokumentacji

| Dokument | Identyfikator | Zawartość |
|----------|---------------|-----------|
| [docs/ISO-21513-raport-koncowy.md](docs/ISO-21513-raport-koncowy.md) | DOC-ISO21513-001 | Raport końcowy: cel, rezultaty, porównanie z planem, wpływ, dalszy rozwój |
| [docs/PMI-lessons-learned.md](docs/PMI-lessons-learned.md) | DOC-PMI-LL-002 | Rejestr wniosków wg PMI: sukcesy, problemy, co zrobić inaczej, rekomendacje |
| [docs/architektura-i-wydajnosc.md](docs/architektura-i-wydajnosc.md) | DOC-ARCH-003 | Architektura, model danych, normalizacja, optymalizacje, pomiary |
| [CONTRIBUTING.md](CONTRIBUTING.md) | — | Zgłaszanie błędów, gałęzie, commity, pull requesty |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | — | Kodeks postępowania (Contributor Covenant 2.1) |
| [CHANGELOG.md](CHANGELOG.md) | — | Historia wersji (Keep a Changelog) |

Każdy dokument w `docs/` zaczyna się od metryki zgodnej z ISO 10013 (identyfikator, wersja,
autor, daty, status) i zawiera tabelę historii zmian.

## Struktura repozytorium

```text
├── .github/              # szablony zgłoszeń i PR, pipeline CI (Biome + bun test + Docker)
├── data/                 # generowany leki.parquet (ignorowany przez git, poza .gitkeep)
├── docs/                 # dokumentacja projektowa (ISO 10013 / ISO 21513 / PMI)
├── scripts/fetch_data.ts # pobieranie i normalizacja wykazu → Parquet
├── src/
│   ├── config.ts         # zmienne środowiskowe z walidacją
│   ├── db.ts             # DuckDB: normalizacja, wyszukiwanie, zamienniki, oszczędności
│   ├── pharmacies.ts     # wyszukiwarka najbliższych aptek (Nominatim + Overpass, cache 15 min)
│   ├── server.ts         # Bun.serve: API, pliki statyczne, Server-Timing, ETag
│   ├── types.ts          # typy domenowe
│   └── public/           # index.html, styles.css, app.js
└── tests/                # 189 testów (bun test) + próbka demo (35 leków)
```

## Autor

**Bartosz Pastuszka** – autor projektu i właściciel praw autorskich (2026-11-22).

## Licencja

[MIT](LICENSE) © 2026 Bartosz Pastuszka (autor, 2026-11-22). Dane źródłowe pochodzą z publicznych
zasobów administracji (dane.gov.pl, gov.pl) i podlegają ich warunkom ponownego wykorzystania.
