# Lessons Learned – projekt TaniLek

## Metryka dokumentu (ISO 10013)

| Pole                            | Wartość                                            |
|---------------------------------|----------------------------------------------------|
| **Identyfikator dokumentu**     | DOC-PMI-LL-002                                     |
| **Tytuł**                       | Rejestr wniosków (Lessons Learned) wg metodyki PMI |
| **Wersja**                      | 1.1.0                                              |
| **Autor**                       | Bartosz Pastuszka                                  |
| **Właściciel praw autorskich**  | Bartosz Pastuszka                                  |
| **Data utworzenia**             | 2026-11-22                                         |
| **Data ostatniej aktualizacji** | 2026-11-22                                         |
| **Status**                      | Zatwierdzony                                       |
| **Klasyfikacja**                | Publiczny (licencja MIT)                           |
| **Dokumenty powiązane**         | DOC-ISO21513-001, DOC-ARCH-003                     |

## Historia zmian

| Wersja | Data       | Autor                     | Opis zmian                  |
|--------|------------|---------------------------|-----------------------------|
| 1.0.0  | 2026-11-22 | Bartosz Pastuszka         | Pierwsze wydanie dokumentu. |
| 1.1.0  | 2026-11-22 | Bartosz Pastuszka         | Wnioski z wydania 1.1.0 (wyszukiwarka aptek OSM, cache plików statycznych): S-08, S-09, C-10, C-11, C-12, R-09. |

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
