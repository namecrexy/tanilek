# Lessons Learned – projekt TaniLek

## Metryka dokumentu (ISO 10013)

| Pole                            | Wartość                                            |
|---------------------------------|----------------------------------------------------|
| **Identyfikator dokumentu**     | DOC-PMI-LL-002                                     |
| **Tytuł**                       | Rejestr wniosków (Lessons Learned) wg metodyki PMI |
| **Wersja**                      | 1.2.0                                              |
| **Autor**                       | Bartosz Pastuszka                                  |
| **Właściciel praw autorskich**  | Bartosz Pastuszka                                  |
| **Data utworzenia**             | 2026-11-22                                         |
| **Data ostatniej aktualizacji** | 2026-11-23                                         |
| **Status**                      | Zatwierdzony                                       |
| **Klasyfikacja**                | Publiczny (licencja MIT)                           |
| **Dokumenty powiązane**         | DOC-ISO21513-001, DOC-ARCH-003                     |

## Historia zmian

| Wersja | Data       | Autor                     | Opis zmian                  |
|--------|------------|---------------------------|-----------------------------|
| 1.0.0  | 2026-11-22 | Bartosz Pastuszka         | Pierwsze wydanie dokumentu. |
| 1.1.0  | 2026-11-22 | Bartosz Pastuszka         | Wnioski z wydania 1.1.0 (wyszukiwarka aptek OSM, cache plików statycznych): S-08, S-09, C-10, C-11, C-12, R-09. |
| 1.2.0  | 2026-11-23 | Bartosz Pastuszka         | Wnioski z wydania 1.2.0 (leki OTC z RPL, kody ATC, średnie ceny, cache wyszukiwania, failover Overpass): S-10–S-13, C-13–C-18, D-08, D-09, R-10–R-12. |

---

## Wprowadzenie

Dokument stanowi rejestr wniosków (*Lessons Learned Register*) zgodnie z praktyką PMI
(PMBOK® Guide – zarządzanie wiedzą projektu, proces zamknięcia projektu). Każdy wniosek
zawiera kategorię, opis sytuacji, wpływ i działanie. Kategorie: **D** – dane, **T** – technologia,
**J** – jakość/testy, **W** – wydajność, **O** – organizacja/proces.

## 1. Co zadziałało dobrze (Successes)

| ID   | Kat. | Sytuacja | Wpływ | Dlaczego zadziałało |
|------|------|----------|-------|---------------------|
| S-01 | T | Wybór DuckDB in-process + Parquet zamiast osobnego serwera bazy. | Jeden proces, brak infrastruktury, start bazy 67 ms, plik danych ~108 KB. | Skala danych (tysiące wierszy) idealnie pasuje do silnika analitycznego osadzonego w procesie. |
| S-02 | T | Smoke test DuckDB pod Bunem na samym początku. | Potwierdzenie zgodności natywnego modułu `@duckdb/node-api` z Bunem przed napisaniem kodu. | Ryzyko techniczne sprawdzone w 5 minut zamiast odkrywane na końcu. |
| S-03 | D | Tryb awaryjny z próbki demo i samonaprawa pliku Parquet. | Aplikacja zawsze startuje – także bez sieci, w CI i w Dockerze. | Wymaganie odporności potraktowane jako funkcja, a nie dodatek. |
| S-04 | J | Logika oszczędności jako czyste funkcje liczone w groszach. | Proste testy jednostkowe, brak błędów zaokrągleń (np. 0,30 − 0,10 = 0,20). | Oddzielenie obliczeń od SQL i HTTP. |
| S-05 | D | Test importu na **rzeczywistym** załączniku XLSX obwieszczenia MZ. | Wykryto 3 błędy niewidoczne na próbce (zob. C-03). Import działa: 4282 pozycje. | Decyzja, by nie poprzestać na zielonych testach na danych syntetycznych. |
| S-06 | W | Pomiar przed optymalizacją (nagłówek `Server-Timing`, p50/p95). | Optymalizacja oparta na liczbach: 12,7 ms → 3,1 ms (p50). | Metryki wbudowane w produkt od pierwszego dnia. |
| S-07 | J | Biome + TypeScript strict + 189 testów w CI. | Jednolity styl, wczesne wykrywanie błędów typów (np. typ `Uint8Array` w `Response`). | Kontrole uruchamiane lokalnie tym samym poleceniem co w CI. |
| S-08 | J | Wstrzykiwalny `fetchFn` w module aptek (`findNearbyPharmacies(query, { fetchFn })`) i opcja `pharmacyFetch` serwera. | 26 testów wyszukiwarki aptek (Haversine, parsowanie `node`/`way`, rozszerzanie promienia 3 → 8 km, cache, błędy `400`/`404`/`502`) działa bez sieci i w ułamku sekundy. | Zależności zewnętrzne przekazywane jawnie zamiast globalnego mockowania. |
| S-09 | W | Cache w pamięci (TTL 15 min) dla zapytań o apteki, z normalizacją wielkości liter i spacji. | Powtórne zapytanie: 4 ms zamiast ~35 s; mniejsze obciążenie publicznych serwerów OpenStreetMap. | Szacunek dla polityki użycia OSM potraktowany jako wymaganie. |
| S-10 | T | Failover 3 serwerów Overpass i tryb awaryjny sprawdzone na **rzeczywistej awarii**: 23.11.2026 wszystkie trzy serwery zwracały `502`/`504` lub przekraczały 8 s. | Użytkownik dostał odpowiedź (przykładowe, wyraźnie oznaczone apteki + link do Map Google) w 9–25 s zamiast błędu. | Awaria publicznej usługi potraktowana jako stan normalny, a nie wyjątek (R-09 z wersji 1.1.0). |
| S-11 | D | Kody ATC dla leków refundowanych pozyskane z RPL przez złączenie po kodzie EAN. | 3 928 z 4 282 leków Rp dostało kod ATC, choć arkusz A1 obwieszczenia go nie zawiera; to umożliwiło automatyczne opisy grup. | Wspólny, stabilny klucz (EAN/GTIN) między rejestrami publicznymi. |
| S-12 | J | Scalanie katalogu (`mergeCatalog`) przetestowane na pliku w schemacie v1.1.0 i ponownym uruchomieniu ETL. | Stare pliki Parquet działają bez migracji; drugie `fetch-data` nie dubluje pozycji OTC; przy braku wykazu MZ zachowywane są dotychczasowe leki Rp. | Zgodność wsteczna i idempotentność zapisane jako testy, a nie założenia. |
| S-13 | J | Testy na pełnych danych i w przeglądarce (headless Edge przez DevTools Protocol) przed wydaniem. | Wykryto błędy, których nie pokazały testy jednostkowe (C-15, C-16, C-17). | Weryfikacja zachowania z perspektywy użytkownika, nie tylko API. |

## 2. Co nie zadziałało / napotkane problemy (Challenges)

| ID   | Kat. | Problem | Wpływ | Rozwiązanie |
|------|------|---------|-------|-------------|
| C-01 | D | Brak bieżącego cennika leków w API `dane.gov.pl`: aktualny wykaz MZ nie jest tam publikowany w formie tabelarycznej, a wyszukiwarka API zwraca zbiory o niskiej trafności (sortowanie po ID). | Pobieranie „z API” nie dostarcza aktualnych dopłat; założenie z planu okazało się nieprawdziwe. | Ocena trafności tytułów i walidacja struktury plików; automatyczne pobieranie arkusza `A1` z załącznika XLSX najnowszego obwieszczenia na `gov.pl` (`MZ_OBWIESZCZENIA_URL`), a przy niepowodzeniu fallback do próbki demo. Wynik: 4 282 leki z obwieszczenia z 16 września 2026 r. (obowiązującego od 1 października 2026 r.). |
| C-02 | D | Kolumny źródła zmieniają nazwy między wydaniami („Identyfikator Leku [kod EAN]” → „Numer GTIN lub inny kod…”), a nazwa, postać i dawka są w jednej komórce. | Mapowanie po stałych nazwach kolumn byłoby kruche. | Reguły rozpoznawania nagłówków po treści + wykrywanie wiersza nagłówka + test regresyjny z nagłówkami z 2026 r. |
| C-03 | T | Czytnik XLSX DuckDB wnioskował szerokość tabeli z pierwszego wiersza (jednokomórkowy tytuł sekcji) i zwracał 1 kolumnę; z jawnym zakresem zwracał ~1 mln pustych wierszy. | Import pełnego wykazu początkowo się nie udawał. | Jawny zakres arkusza + usuwanie pustych wierszy (bez `stop_at_empty`, które ucięłoby dane po pustym wierszu). |
| C-04 | T | `ILIKE … ESCAPE` z parametrem dawało inne wyniki niż z literałem. | Ryzyko, że fraza `%` zwróci całą bazę. | Usuwanie znaków wieloznacznych z frazy przed budową wzorca + testy „%%” i „_____”. |
| C-05 | T | `GROUP BY ALL` nie obsłużył wyrażenia łączącego agregat z kolumną. | Błąd bindera przy pierwszym uruchomieniu zapytania. | Jawna lista kolumn grupowania; później całkowite wyeliminowanie złączenia przez materializację. |
| C-06 | O | Brak Dockera na stacji roboczej. | Obrazu nie dało się zweryfikować lokalnie. | Zadanie CI budujące obraz i wykonujące smoke test endpointów. |
| C-07 | J | Pliki CSV z dane.gov.pl bywają w kodowaniu Windows-1250. | Uszkodzone polskie znaki w nazwach leków. | Dekodowanie UTF-8 w trybie `fatal`, a przy błędzie Windows-1250; test jednostkowy. |
| C-08 | T | Plik MZ zawiera wieloliniowe komórki (znaki nowej linii w cudzysłowach), których równoległy czytnik CSV DuckDB nie dzielił poprawnie między wątki. | Przesunięte lub zgubione wiersze przy imporcie. | Wyłączenie równoległego odczytu CSV (`parallel=false`) w `read_csv`; przy kilku tysiącach wierszy koszt czasowy jest pomijalny. |
| C-09 | D | Rozdzielanie pola „Nazwa, postać i dawka” po przecinku psuło dawki z przecinkiem dziesiętnym (np. `0,03+0,15 mg`). | Błędna dawka, a więc i błędny klucz grupy zamienników. | Separatorem jest tylko przecinek ze spacją (przecinki dziesiętne jej nie mają); test regresyjny z przykładami z obwieszczenia z 16.09.2026. |
| C-10 | T | Publiczne Overpass API odpowiadało w ~30 s, a okresowo zwracało `502`/`406`. | Domyślny `idleTimeout` `Bun.serve` (10 s) zrywał połączenie, zanim przyszła odpowiedź – przeglądarka dostawała pustą odpowiedź zamiast JSON. | `idleTimeout: 120`, osobne limity zapytań (Nominatim 10 s, Overpass 35 s), czytelny komunikat `502` po polsku i log z kodem HTTP źródła. |
| C-11 | J | `app.js` i `styles.css` serwowane z `max-age=3600` – po wdrożeniu użytkownicy przez godzinę widzieli stary interfejs ze świeżym HTML. | Niespójność HTML ↔ JS po aktualizacji. | `Cache-Control: no-cache` + `ETag` (tanie odpowiedzi `304`) i parametr `?v=1.1.0` w odwołaniach. |
| C-12 | D | Dane aptek w OSM są niekompletne (brak adresu lub godzin otwarcia przy części obiektów). | Część kart pokazuje tylko nazwę i dystans. | Pola opcjonalne w UI, domyślna nazwa „Apteka”, informacja o źródle (© OpenStreetMap) i odległości w linii prostej. |
| C-13 | D | Rejestr Produktów Leczniczych nie zawiera cen, a ceny leków OTC nie są regulowane. | Brak podstawy do „średniej ceny rynkowej” z danych publicznych. | Szacunek: znana cena tej samej marki i dawki (wbudowany zestaw) albo typowa cena grupy ATC, skalowana wielkością opakowania; w UI zawsze „ok.” + linki KtoMaLek / GdziePoLek; dokumentacja jawnie nazywa to szacunkiem. |
| C-14 | D | Ok. 11,7 tys. opakowań OTC w RPL nie ma kodu ATC – głównie preparaty homeopatyczne (po 48 rozcieńczeń na produkt). | Bez filtra zalałyby wyniki wyszukiwania pozycjami bez opisu i bez podstawy do ceny. | Opakowania bez kodu ATC są pomijane; licznik pominiętych w logu ETL. Pole ATC z kilkoma kodami („C05AX03, C05AD01”) – brany pierwszy poprawny. |
| C-15 | T | Pierwsza wersja szacunku ceny dla dużych opakowań popularnych marek była zawyżona (np. Rutinoscorbin 210 tabl. ≈ 120 zł z ogólnej średniej grupy ATC). | Nierealistyczne „ceny orientacyjne” podważałyby zaufanie do narzędzia. | Cena z najbliższego wielkością opakowania tej samej marki i dawki z wbudowanego zestawu (210 tabl. ≈ 28,49 zł). |
| C-16 | J | Pigułka „Z pamięci podręcznej” pokazywała „Pobrano na żywo” przy powtórzonym wyszukiwaniu – przeglądarka zwracała własną kopię odpowiedzi (`max-age=60`) z polem `cached: false`. | Nieprawdziwa informacja w UI. | `ETag` liczony bez pól `cached`/`durationMs`, a interfejs pobiera wyniki z `cache: "no-store"` – pole opisuje bieżące żądanie. |
| C-17 | T | Serwer gov.pl wysyła załącznik skompresowany (gzip), więc `Content-Length` był mniejszy niż pobrane dane – pasek postępu pokazywał „100% · 0.9 MB / 0.8 MB”. | Mylący pasek postępu w ETL. | Pobieranie plików z `Accept-Encoding: identity`; przy `Content-Encoding` lub zaniżonym rozmiarze – tylko liczba MB; test regresyjny. |
| C-18 | J | Przy skryptowej edycji kodu utracono znak `\` w wyrażeniu regularnym klucza cache (`/\s+/` → `/s+/`) – „crestor” zamieniał się w „cre tor”; alias „Laremid” prowadził do nieistniejącej substancji. | Błędne klucze cache i wyszukiwanie marki. | Oba błędy wykryte przez nowe testy (`searchCacheKey`, tabela marek OTC) przed wydaniem i poprawione. |

## 3. Co zrobilibyśmy inaczej (What We Would Do Differently)

| ID   | Wniosek | Uzasadnienie |
|------|---------|--------------|
| D-01 | **Zweryfikować dostępność i format źródła danych przed zatwierdzeniem zakresu.** | Założenie „dane są na dane.gov.pl jako CSV” było nieprawdziwe; wcześniejsza weryfikacja pozwoliłaby od razu zaplanować `SOURCE_URL` i rozmowę z dostawcą danych. |
| D-02 | Dodać do zestawu testów zanonimizowany wycinek prawdziwego pliku XLSX od pierwszego dnia. | Próbka syntetyczna „pasowała” do kodu, bo powstała razem z nim – nie ujawniała problemów formatu. |
| D-03 | Mierzyć wydajność na danych o docelowej skali, a nie na próbce. | Na 35 wierszach każde rozwiązanie jest „szybkie”; różnica 4× ujawniła się dopiero przy 4282 pozycjach. |
| D-04 | Zapewnić środowisko z Dockerem lub wcześniej przygotować zadanie CI dla obrazu. | Weryfikacja obrazu dopiero w CI wydłuża pętlę informacji zwrotnej. |
| D-06 | Od początku traktować `gov.pl` jako podstawowe źródło wykazu, a `dane.gov.pl` jako dodatkowe. | API `dane.gov.pl` nie zawiera bieżącego cennika; automatyczne pobieranie arkusza `A1` z fallbackiem do próbki należało zaplanować w zakresie, a nie dodawać po fakcie. |
| D-07 | Testować parser na rzeczywistych, „brzydkich” danych: wieloliniowe komórki, przecinki dziesiętne, kilka dawek w jednym polu. | Błędy `parallel=false` i `0,03+0,15 mg` ujawniły się dopiero na pełnym pliku MZ. |
| D-05 | Zaplanować od początku obsługę uprawnień dodatkowych (S, DZ). | To istotne dla grupy docelowej (seniorzy), a wymaga dodatkowych źródeł danych. |
| D-08 | Przed zaplanowaniem funkcji „średnia cena rynkowa OTC” sprawdzić, czy jakiekolwiek publiczne źródło zawiera ceny. | Wymaganie zakładało dane, których nie ma w RPL; uczciwy szacunek trzeba było zaprojektować w trakcie (C-13). |
| D-09 | Profilować zawartość nowego źródła (rozkład kategorii, braki ATC) przed napisaniem parsera. | Skala preparatów homeopatycznych bez ATC (C-14) wyszła dopiero w pierwszym przebiegu na pełnych danych. |

## 4. Rekomendacje dla przyszłych projektów open source (Recommendations)

| ID   | Rekomendacja | Zastosowanie |
|------|--------------|--------------|
| R-01 | **Projektuj pod niestabilne dane publiczne:** rozpoznawanie kolumn po treści, walidacja minimalnej liczby wierszy, atomowa podmiana pliku i tryb awaryjny. | Każdy projekt oparty na publikacjach urzędowych w XLSX/CSV. |
| R-02 | **Wbuduj obserwowalność w produkt** (np. `Server-Timing`) – metryki widoczne w UI ułatwiają współtwórcom ocenę wpływu zmian. | Projekty z wymaganiami wydajnościowymi. |
| R-03 | **Aplikacja musi działać „od strzału”** – dołącz małą próbkę danych i tryb demo; to obniża próg wejścia dla nowych współtwórców i upraszcza CI. | Wszystkie projekty zależne od zewnętrznych danych/usług. |
| R-04 | **Jedno polecenie = te same kontrole lokalnie i w CI** (`lint`, `typecheck`, `test`). | Wszystkie projekty open source. |
| R-05 | **Licz pieniądze w groszach i testuj przypadki brzegowe** (0 zł, różne opakowania, droższy zamiennik). | Projekty z obliczeniami finansowymi. |
| R-06 | **Bądź jawny co do ograniczeń** – dokumentuj, czego narzędzie nie robi (np. nie zastępuje farmaceuty, nie uwzględnia uprawnień „S”). | Projekty o wpływie na zdrowie i finanse użytkowników. |
| R-07 | **Kontroluj dokumenty** – metryka (ID, wersja, status) i historia zmian w każdym dokumencie (ISO 10013) ułatwiają utrzymanie przez rotujących wolontariuszy. | Projekty z dokumentacją formalną. |
| R-08 | **Zgłaszaj potrzeby do dostawców danych** – publikacja wykazu MZ w formie CSV/API na dane.gov.pl przyniosłaby korzyść wszystkim podobnym inicjatywom. | Projekty civic tech. |
| R-09 | **Traktuj publiczne API jako zawodne** – limity czasu, cache, komunikat dla użytkownika i plan B (własna instancja lub serwer zapasowy). | Projekty korzystające z darmowych usług społecznościowych (OSM, Overpass, Nominatim). |
| R-10 | **Oznaczaj dane szacowane wprost** – „ok.”, osobna etykieta kategorii i link do źródła rzeczywistej ceny; nie porównuj w jednej grupie wartości urzędowych z szacunkami. | Projekty łączące dane urzędowe z danymi przybliżonymi. |
| R-11 | **Łącz rejestry publiczne po stabilnych identyfikatorach** (EAN/GTIN, kody ATC) zamiast po nazwach. | Projekty integrujące kilka źródeł danych o lekach lub produktach. |
| R-12 | **Wskaźniki w UI (cache, czas) muszą opisywać bieżące żądanie** – uwzględniaj warstwę cache przeglądarki i proxy. | Projekty pokazujące metryki wydajności użytkownikowi. |
