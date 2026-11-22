# Jak współtworzyć TaniLek

Dziękujemy za zainteresowanie projektem! TaniLek pomaga pacjentom znaleźć tańsze odpowiedniki
leków refundowanych, dlatego szczególnie zależy nam na **poprawności danych**, **dostępności**
interfejsu i **wydajności**. Udział w projekcie oznacza akceptację [Kodeksu postępowania](CODE_OF_CONDUCT.md).

## Zgłaszanie błędów

1. Sprawdź [listę zgłoszeń](../../issues), czy problem nie został już opisany.
2. Utwórz nowe zgłoszenie z szablonu **„Zgłoszenie błędu”**.
3. Podaj kroki do odtworzenia, wersję Bun, sposób uruchomienia (Docker/Bun) oraz wartość
   `data.source` z `GET /api/health` (`parquet` lub `fallback-demo`).
4. **Nie publikuj danych osobowych ani informacji o własnym leczeniu.**

Błędy bezpieczeństwa zgłaszaj prywatnie opiekunom repozytorium (GitHub → zakładka
*Security* → *Report a vulnerability*), a nie w publicznym zgłoszeniu.

## Propozycje funkcji

Użyj szablonu **„Propozycja funkcji”**. Opisz problem użytkownika, a dopiero potem rozwiązanie.

## Przygotowanie środowiska

```bash
git clone https://github.com/<twoje-konto>/tanilek.git
cd tanilek
bun install
cp .env.example .env
bun run build-demo-data   # data/leki.parquet z próbki (bez sieci)
bun run dev               # serwer z automatycznym przeładowaniem: http://localhost:3000
```

## Gałęzie

Pracujemy w modelu *GitHub Flow*: gałąź `main` jest zawsze stabilna, każda zmiana trafia
do niej przez pull request.

| Prefiks gałęzi | Zastosowanie                         | Przykład                          |
|----------------|--------------------------------------|-----------------------------------|
| `feat/`        | nowa funkcja                         | `feat/filtr-poziomu-odplatnosci`  |
| `fix/`         | poprawka błędu                       | `fix/przeliczanie-opakowan`       |
| `perf/`        | optymalizacja wydajności             | `perf/indeks-ean`                 |
| `docs/`        | dokumentacja                         | `docs/instrukcja-docker`          |
| `chore/`       | narzędzia, CI, zależności            | `chore/aktualizacja-biome`        |

```bash
git switch -c feat/krotki-opis
```

## Commity

Stosujemy [Conventional Commits](https://www.conventionalcommits.org/pl/v1.0.0/):

```
feat(search): wyszukiwanie po kodzie EAN
fix(db): poprawne przeliczanie dopłaty dla opakowań 28/30 szt.
docs: opis zmiennej SOURCE_URL
```

## Pull requesty

Przed otwarciem PR uruchom lokalnie wszystkie kontrole – te same wykonuje pipeline CI:

```bash
bun run lint        # Biome: lint + formatowanie (bun run lint:fix naprawia automatycznie)
bun run typecheck   # TypeScript w trybie strict
bun test            # testy jednostkowe i integracyjne
```

Wymagania wobec PR:

- wypełniony szablon PR i powiązane zgłoszenie (`Closes #123`),
- testy dla nowej logiki (szczególnie obliczeń oszczędności i normalizacji danych),
- wpis w `CHANGELOG.md` w sekcji **Unreleased**,
- zmiana dokumentu w `docs/` = podbicie wersji w metryce i nowy wiersz w tabeli
  *Historia zmian* (kontrola dokumentów wg ISO 10013),
- brak sekretów oraz zahardkodowanych adresów, portów i ścieżek – konfiguracja wyłącznie
  przez zmienne środowiskowe (`src/config.ts`, `.env.example`),
- zmiany w zapytaniach SQL: podaj czasy z nagłówka `Server-Timing` przed i po zmianie.

PR wymaga zielonego CI i co najmniej jednej akceptacji opiekuna. Scalamy metodą *squash merge*.

## Styl kodu

- TypeScript `strict`, formatowanie i lint wyłącznie przez Biome (`biome.json`).
- Wartości od użytkownika trafiają do SQL **tylko** jako parametry przygotowanych zapytań.
- Kwoty pieniężne liczymy w groszach (liczby całkowite), aby uniknąć błędów zaokrągleń.
- Interfejs: bez zależności i bundlera; dane wstawiamy przez `textContent` (ochrona przed XSS);
  zachowujemy kontrast WCAG 2.1 AA i obsługę klawiatury.
