// TaniLek – logika interfejsu (czysty JavaScript, bez bundlera i zależności).
// Dane z API wstawiane są wyłącznie przez textContent – brak ryzyka XSS.

const DEBOUNCE_MS = 150;
const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 30;

const pln = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const pct = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
const ms = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = new Intl.NumberFormat("pl-PL", { useGrouping: true });

const $ = (id) => document.getElementById(id);
const els = {
  form: $("search-form"),
  input: $("q"),
  status: $("status"),
  note: $("resolved-note"),
  doseFilters: $("dose-filters"),
  results: $("wyniki"),
  loadMore: $("load-more"),
  loadMoreBtn: $("load-more-btn"),
  loadMoreInfo: $("load-more-info"),
  details: $("details"),
  perfPill: $("perf-pill"),
  perfDb: $("perf-db"),
  perfRows: $("perf-rows"),
  perfDetails: $("perf-details"),
  demoBanner: $("demo-banner"),
  dataSource: $("data-source"),
  appVersion: $("app-version"),
  searchCache: $("search-cache"),
  searchProgress: $("search-progress"),
  categoryFilters: $("category-filters"),
  pharmacyFinder: $("pharmacy-finder"),
  pharmacyForm: $("pharmacy-form"),
  pharmacyInput: $("pharmacy-q"),
  pharmacyStatus: $("pharmacy-status"),
  pharmacyCache: $("pharmacy-cache"),
  pharmacyProgress: $("pharmacy-progress"),
  pharmacyResults: $("pharmacy-results"),
  pharmacySummary: $("pharmacy-summary"),
  pharmacyList: $("pharmacy-list"),
  pharmacyPriceNote: $("pharmacy-price-note"),
  pharmacyDrugLabel: $("pharmacy-drug-label"),
  ktomalekLink: $("ktomalek-link"),
  gdziepolekLink: $("gdziepolek-link"),
};

const CATEGORY_LABELS = {
  wszystkie: "Wszystkie",
  Rp: "Refundowane (NFZ)",
  OTC: "Bez recepty (OTC)",
};

const LOCATION_STORAGE_KEY = "tanilek_location";
const km = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

const PLACEHOLDER_TEXT =
  "Wybierz lek z listy, aby zobaczyć tańsze odpowiedniki o tej samej substancji czynnej, dawce i postaci.";

let searchController = null;
let detailsController = null;
let selectedId = null;
/** Ostatni wynik wyszukiwania i aktywny filtr dawki (null = wszystkie). */
let lastResult = null;
let activeDose = null;
/** Aktywny filtr kategorii dostępności: „wszystkie”, „Rp” lub „OTC” (filtrowanie po stronie serwera). */
let activeCategory = "wszystkie";
/** Bieżący limit zapytania do /api/search – rośnie o RESULT_LIMIT po „Pokaż więcej wyników”. */
let resultLimit = RESULT_LIMIT;
/** Maksymalny limit akceptowany przez serwer (aktualizowany z /api/health). */
let maxResultLimit = 500;

/**
 * Tworzy element DOM z atrybutami i dziećmi (tekst zawsze przez textContent).
 * @param {string} tag
 * @param {Record<string, string> | null} [attrs]
 * @param {...(Node | string | null | undefined | false)} children
 */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") el.className = value;
      else el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Polska odmiana: 1 lek, 2–4 leki, 5+ leków (z wyjątkiem 12–14). */
function pluralLeki(n) {
  if (n === 1) return "1 lek";
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${int.format(n)} leki`;
  return `${int.format(n)} leków`;
}

function pluralPozycja(n) {
  if (n === 1) return "1 pozycja";
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${n} pozycje`;
  return `${n} pozycji`;
}

/**
 * Parsuje nagłówek Server-Timing, np. `db;dur=0.412;desc="DuckDB query", total;dur=1.03`.
 * @param {string | null} header
 * @returns {Record<string, number>}
 */
function parseServerTiming(header) {
  const result = {};
  if (!header) return result;
  for (const entry of header.split(",")) {
    const [name, ...params] = entry.trim().split(";");
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith("dur="));
    if (name && dur) result[name.trim()] = Number.parseFloat(dur.slice(4));
  }
  return result;
}

function showMetrics(response, rttMs) {
  const timing = parseServerTiming(response.headers.get("Server-Timing"));
  const fromCache = response.status === 304;
  els.perfDb.textContent = timing.db !== undefined ? `DuckDB ${ms.format(timing.db)} ms` : "DuckDB – ms";
  const parts = [];
  if (timing.total !== undefined) parts.push(`serwer ${ms.format(timing.total)} ms`);
  parts.push(`sieć + przeglądarka ${ms.format(rttMs)} ms${fromCache ? " (cache)" : ""}`);
  els.perfPill.title = `Czas zapytania w bazie DuckDB · ${parts.join(" · ")}`;
  els.perfDetails.textContent = `Ostatni pomiar: ${parts.join(", ")}.`;
  els.perfPill.classList.remove("fresh");
  // Wymuszenie ponownego zastosowania klasy (krótkie wyróżnienie nowego pomiaru).
  void els.perfPill.offsetWidth;
  els.perfPill.classList.add("fresh");
}

/**
 * @param {{ metrics?: boolean, fresh?: boolean }} [options] – `fresh`: z pominięciem cache przeglądarki, aby pola
 *   `cached`/`durationMs` opisywały bieżące żądanie (pamięć podręczna serwera), a nie zapamiętaną kopię odpowiedzi.
 */
async function fetchJson(url, signal, { metrics = true, fresh = false } = {}) {
  const started = performance.now();
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
    ...(fresh ? { cache: "no-store" } : {}),
  });
  const rtt = performance.now() - started;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && typeof body.error === "string" ? body.error : `Błąd serwera (${response.status}).`;
    throw new Error(message);
  }
  if (metrics) showMetrics(response, rtt);
  return body;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function setNote(text) {
  els.note.textContent = text || "";
  els.note.hidden = !text;
}

/* ------------------------------------------------------------------ Pasek postępu */

/**
 * Animowany pasek postępu z procentami i opisem etapu, np. „65% — Pobieranie aptek z OpenStreetMap…”.
 * Serwer nie raportuje postępu, więc etapy są odmierzane czasem (z wolnym „pełzaniem” do ~92%),
 * a 100% — Gotowe pokazywane jest po faktycznym otrzymaniu odpowiedzi.
 * @param {HTMLElement} container
 */
function createProgress(container) {
  const fill = h("div", { class: "progress-fill" });
  const label = h("p", { class: "progress-label" });
  const bar = h(
    "div",
    {
      class: "progress-track",
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": "0",
    },
    fill,
  );
  container.replaceChildren(bar, label);
  let timers = [];
  let creep = 0;
  let current = 0;
  let hideTimer = 0;

  const clear = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    clearInterval(creep);
    clearTimeout(hideTimer);
  };
  const set = (percent, text) => {
    current = Math.max(current, Math.min(100, Math.round(percent)));
    fill.style.width = `${current}%`;
    bar.setAttribute("aria-valuenow", String(current));
    bar.setAttribute("aria-valuetext", `${current}% — ${text}`);
    label.textContent = `${current}% — ${text}`;
  };

  return {
    /**
     * @param {{ at: number, percent: number, text: string }[]} stages – etapy (at = ms od startu)
     * @param {{ delay?: number, creepTo?: number }} [options] – opóźnienie pokazania (bez migania przy szybkich
     *   odpowiedziach) i górna granica „pełzania” ostatniego etapu
     */
    start(stages, { delay = 0, creepTo = 92 } = {}) {
      clear();
      current = 0;
      fill.style.width = "0%";
      container.classList.remove("is-done", "is-error");
      const show = () => {
        container.hidden = false;
      };
      if (delay > 0) timers.push(setTimeout(show, delay));
      else show();
      for (const stage of stages) {
        timers.push(
          setTimeout(() => {
            set(stage.percent, stage.text);
          }, stage.at),
        );
      }
      const last = stages[stages.length - 1];
      if (last) {
        timers.push(
          setTimeout(() => {
            creep = setInterval(() => {
              if (current < creepTo) set(current + 1, label.textContent.replace(/^\d+% — /, ""));
            }, 700);
          }, last.at + 400),
        );
      }
    },
    done(text = "Gotowe") {
      const wasVisible = !container.hidden;
      clear();
      set(100, text);
      container.classList.add("is-done");
      if (!wasVisible) {
        container.hidden = true;
        return;
      }
      hideTimer = setTimeout(() => {
        container.hidden = true;
      }, 1200);
    },
    fail() {
      clear();
      container.classList.add("is-error");
      container.hidden = true;
    },
  };
}

const searchProgress = createProgress(els.searchProgress);
const pharmacyProgress = createProgress(els.pharmacyProgress);

/* ------------------------------------------------------------------ Pigułka cache */

function formatMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "– ms";
  if (n < 1) return "<1 ms";
  return `${int.format(Math.round(n))} ms`;
}

/**
 * Dyskretna pigułka statusu pamięci podręcznej przy wynikach:
 * „⚡ Z pamięci podręcznej (2 ms)” / „🌐 Pobrano na żywo (140 ms)” / tryb awaryjny aptek.
 * @param {HTMLElement} el
 * @param {{ cached?: boolean, durationMs?: number, isFallback?: boolean } | null} result
 */
function showCachePill(el, result) {
  if (!result || typeof result.cached !== "boolean") {
    el.hidden = true;
    return;
  }
  el.classList.remove("is-cached", "is-live", "is-fallback");
  if (result.isFallback) {
    el.textContent = `⚠️ Tryb awaryjny – przykładowe apteki (${formatMs(result.durationMs)})`;
    el.classList.add("is-fallback");
    el.title = "Serwery OpenStreetMap nie odpowiedziały – pokazujemy przykładowe apteki w okolicy.";
  } else if (result.cached) {
    el.textContent = `⚡ Z pamięci podręcznej (${formatMs(result.durationMs)})`;
    el.classList.add("is-cached");
    el.title = "Wynik z pamięci podręcznej serwera – bez ponownego zapytania.";
  } else {
    el.textContent = `🌐 Pobrano na żywo (${formatMs(result.durationMs)})`;
    el.classList.add("is-live");
    el.title = "Wynik obliczony na żywo przez serwer.";
  }
  el.hidden = false;
}

function isOtc(drug) {
  return drug?.kategoriaDostepnosci === "OTC";
}

function drugTitle(drug) {
  return [drug.nazwa, drug.dawka].filter(Boolean).join(" ");
}

function describeDrug(drug) {
  return [drug.substancja_czynna, drug.postac, drug.opakowanie].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------ Panel szczegółów */

/**
 * Podmienia zawartość panelu szczegółów. Wyszukiwarka aptek może być osadzona wewnątrz panelu
 * (pod boksem „Najtańsza opcja”), więc przed podmianą wraca na swoje domyślne miejsce pod panelem –
 * inaczej `replaceChildren` odłączyłby ją od dokumentu razem z jej stanem (wpisany adres, lista aptek).
 * @param {...Node} nodes
 */
function setDetails(...nodes) {
  if (els.details.contains(els.pharmacyFinder)) els.details.after(els.pharmacyFinder);
  els.details.replaceChildren(...nodes);
}

function showPlaceholder() {
  detailsController?.abort();
  setDetails(h("p", { class: "placeholder" }, PLACEHOLDER_TEXT));
  updateAvailabilityLinks(null);
}

function showEmptyDetails(query) {
  detailsController?.abort();
  setDetails(
    h(
      "div",
      { class: "empty-state" },
      h("strong", null, `Nic nie znaleźliśmy dla „${query}”`),
      "Sprawdź pisownię lub wpisz nazwę substancji czynnej z ulotki (np. „atorwastatyna”, „metformina”).",
    ),
  );
}

/* ------------------------------------------------------------------ Filtry dawek */

function doseSortKey(dose) {
  const match = /([\d.,]+)/.exec(dose);
  return match ? Number.parseFloat(match[1].replace(",", ".")) : Number.POSITIVE_INFINITY;
}

function distinctDoses(items) {
  const doses = [...new Set(items.map((i) => (i.dawka || "").trim()).filter(Boolean))];
  return doses.sort((a, b) => doseSortKey(a) - doseSortKey(b) || a.localeCompare(b, "pl"));
}

function renderDoseFilters(items) {
  const doses = distinctDoses(items);
  if (doses.length < 2) {
    els.doseFilters.hidden = true;
    els.doseFilters.replaceChildren();
    return;
  }
  const make = (label, value) => {
    const btn = h("button", { type: "button", class: "pill", "aria-pressed": String(activeDose === value) }, label);
    btn.addEventListener("click", () => {
      activeDose = value;
      renderDoseFilters(lastResult.items);
      renderResultList();
    });
    return btn;
  };
  els.doseFilters.replaceChildren(
    h("legend", { class: "visually-hidden" }, "Filtruj według dawki"),
    make("Wszystkie", null),
    ...doses.map((d) => make(d, d)),
  );
  els.doseFilters.hidden = false;
}

/* ------------------------------------------------------------------ Lista wyników */

function pluralOpakowanie(n) {
  if (n === 1) return "1 opakowanie";
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${n} opakowania`;
  return `${n} opakowań`;
}

/**
 * Grupuje wyniki po nazwie, dawce i postaci (kolejność pierwszego wystąpienia grupy z API).
 * Warianty w grupie są posortowane od najniższej dopłaty.
 */
function groupResults(items) {
  const groups = new Map();
  for (const item of items) {
    const key = [item.kategoriaDostepnosci, item.nazwa, item.dawka, item.postac]
      .map((v) => (v || "").trim().toLowerCase())
      .join("\u0000");
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].map((variants) =>
    [...variants].sort(
      (a, b) =>
        a.doplata_pacjenta - b.doplata_pacjenta || (b.liczba_jednostek ?? 0) - (a.liczba_jednostek ?? 0) || a.id - b.id,
    ),
  );
}

/** Krótka forma poziomu odpłatności do etykiet pigułek (np. „bezpłatny do limitu” → „bezpł.”). */
function shortLevel(level) {
  const value = (level || "").trim();
  return /^bezp/i.test(value) ? "bezpł." : value;
}

/** Etykieta pigułki opakowania; przy powtórzonej wielkości opakowania dodaje poziom odpłatności. */
function variantLabel(variant, variants) {
  const size = (variant.opakowanie || "").trim() || "opak.";
  const duplicated = variants.some(
    (other) => other !== variant && (other.opakowanie || "").trim() === (variant.opakowanie || "").trim(),
  );
  const level = isOtc(variant) ? "" : shortLevel(variant.poziom_odplatnosci);
  const sizeLabel = duplicated && level ? `${size} (${level})` : size;
  return `${sizeLabel} • ${isOtc(variant) ? "ok. " : ""}${pln.format(variant.doplata_pacjenta)}`;
}

function resultCard(variants) {
  // Warianty są posortowane od najtańszego – pierwszy jest domyślnym wariantem karty.
  const [cheapest] = variants;
  const ids = variants.map((v) => v.id);
  const maxSaving = Math.max(...variants.map((v) => v.mozliwa_oszczednosc || 0));
  const hasEquivalents = variants.some((v) => v.liczba_zamiennikow > 0);
  const otc = isOtc(cheapest);
  const extra =
    maxSaving > 0
      ? h("span", { class: "badge-save" }, `${otc ? "Taniej o ok." : "Oszczędź do"} ${pln.format(maxSaving)}`)
      : hasEquivalents
        ? h("span", { class: "badge-muted" }, "Najtańszy w grupie")
        : null;
  const price = `${otc ? "ok. " : ""}${pln.format(cheapest.doplata_pacjenta)}`;
  const priceText = variants.length > 1 ? `od ${price}` : price;
  const meta = [cheapest.substancja_czynna, cheapest.postac].filter(Boolean).join(" · ");
  const categoryTag = otc
    ? h("span", { class: "tag tag-otc", title: "Lek bez recepty – cena orientacyjna" }, "OTC")
    : h("span", { class: "tag tag-rp", title: "Lek refundowany przez NFZ na receptę" }, "NFZ");

  const button = h(
    "button",
    {
      type: "button",
      class: "result-btn",
      "aria-pressed": String(ids.includes(selectedId)),
      "data-ids": ids.join(","),
      title: otc
        ? `Orientacyjna cena rynkowa: ${pln.format(cheapest.doplata_pacjenta)}`
        : `Najniższa dopłata pacjenta: ${pln.format(cheapest.doplata_pacjenta)}`,
    },
    h(
      "span",
      { class: "result-name" },
      cheapest.nazwa,
      cheapest.dawka ? h("span", { class: "dose" }, cheapest.dawka) : null,
      categoryTag,
    ),
    h("span", { class: "result-price price" }, priceText),
    h("span", { class: "result-meta" }, meta),
    h("span", { class: "result-extra" }, extra),
  );
  button.addEventListener("click", () => selectDrug(cheapest.id));

  const pills = variants.map((variant) => {
    const isActive = variant.id === selectedId;
    const pill = h(
      "button",
      {
        type: "button",
        class: `variant-pill${isActive ? " active" : ""}`,
        "aria-pressed": String(isActive),
        "data-id": String(variant.id),
        title: isOtc(variant)
          ? `${variant.opakowanie || "Opakowanie"} · bez recepty, cena orientacyjna · EAN ${variant.kod_ean || "—"}`
          : `${variant.opakowanie || "Opakowanie"} · odpłatność ${variant.poziom_odplatnosci || "—"} · EAN ${variant.kod_ean || "—"}`,
      },
      variantLabel(variant, variants),
    );
    pill.addEventListener("click", () => selectDrug(variant.id));
    return pill;
  });

  return h(
    "li",
    { class: "result-card" },
    button,
    h("div", { class: "variant-pills", role: "group", "aria-label": `Opakowania: ${drugTitle(cheapest)}` }, ...pills),
  );
}

function renderResultList() {
  const items = lastResult.items.filter((i) => activeDose === null || (i.dawka || "").trim() === activeDose);
  const groups = groupResults(items);
  els.results.replaceChildren(...groups.map(resultCard));
  const category = activeCategory !== "wszystkie" ? ` · ${CATEGORY_LABELS[activeCategory]}` : "";
  const suffix = `${activeDose ? ` · dawka ${activeDose}` : ""}${category}`;
  const fetched = lastResult.items.length;
  const total = totalMatches(lastResult);
  if (total > fetched) {
    // Część dopasowań nie została jeszcze pobrana – pokazujemy „X z Y opakowań”.
    const info = `Wyświetlono ${pluralPozycja(groups.length)} (${int.format(fetched)} z ${pluralOpakowanie(total)})`;
    setStatus(`${info}${suffix}`);
    els.loadMoreInfo.textContent = info;
  } else {
    const packs = groups.length !== items.length ? ` (${pluralOpakowanie(items.length)})` : "";
    setStatus(`${pluralPozycja(groups.length)}${packs}${suffix}`);
  }
  renderLoadMore(fetched, total);
}

/** Łączna liczba dopasowań w bazie dla aktywnej kategorii (z liczników serwera). */
function totalMatches(result) {
  return result?.liczniki?.[activeCategory] ?? result?.items.length ?? 0;
}

/** Przycisk „Pokaż więcej wyników” – widoczny, gdy w bazie jest więcej dopasowań niż pobrano. */
function renderLoadMore(fetched, total) {
  const more = total > fetched;
  els.loadMore.hidden = !more;
  if (!more) {
    els.loadMoreInfo.textContent = "";
    return;
  }
  const atMax = resultLimit >= maxResultLimit;
  els.loadMoreBtn.disabled = atMax;
  els.loadMoreBtn.title = atMax
    ? `Osiągnięto maksymalny limit ${int.format(maxResultLimit)} wyników – zawęź zapytanie.`
    : "";
}

els.loadMoreBtn.addEventListener("click", () => {
  if (!lastResult || resultLimit >= maxResultLimit) return;
  resultLimit = Math.min(resultLimit + RESULT_LIMIT, maxResultLimit);
  els.loadMoreBtn.disabled = true;
  runSearch(els.input.value, { more: true });
});

/** Odświeża zaznaczenie kart i pigułek opakowań bez przebudowy listy. */
function updateSelectionState() {
  for (const btn of els.results.querySelectorAll(".result-btn")) {
    const ids = (btn.dataset.ids || "").split(",").map(Number);
    btn.setAttribute("aria-pressed", String(ids.includes(selectedId)));
  }
  for (const pill of els.results.querySelectorAll(".variant-pill")) {
    const isActive = Number(pill.dataset.id) === selectedId;
    pill.classList.toggle("active", isActive);
    pill.setAttribute("aria-pressed", String(isActive));
  }
}

/* ------------------------------------------------------------------ Filtry kategorii (Rp / OTC) */

/**
 * Przełącznik „Wszystkie / Refundowane (NFZ) / Bez recepty (OTC)” z licznikami pozycji z serwera
 * (`liczniki` obejmują wszystkie pasujące leki, niezależnie od limitu wyników i aktywnego filtra).
 */
function renderCategoryFilters(result) {
  const counts = result?.liczniki;
  if (!counts || counts.wszystkie === 0) {
    els.categoryFilters.hidden = true;
    return;
  }
  for (const btn of els.categoryFilters.querySelectorAll(".category-pill")) {
    const key = btn.dataset.kategoria;
    const count = counts[key] ?? 0;
    const active = key === activeCategory;
    btn.setAttribute("aria-pressed", String(active));
    btn.disabled = count === 0 && !active;
    const badge = btn.querySelector(".count");
    if (badge) badge.textContent = int.format(count);
    btn.title = `${CATEGORY_LABELS[key]}: ${pluralPozycja(count)}`;
  }
  els.categoryFilters.hidden = false;
}

for (const btn of els.categoryFilters.querySelectorAll(".category-pill")) {
  btn.addEventListener("click", () => {
    const next = btn.dataset.kategoria || "wszystkie";
    if (next === activeCategory) return;
    activeCategory = next;
    runSearch(els.input.value);
  });
}

function renderResults(result, { more = false } = {}) {
  lastResult = result;
  // Po „Pokaż więcej wyników” zachowujemy wybrany filtr dawki, o ile nadal występuje w wynikach.
  if (!more || !result.items.some((i) => (i.dawka || "").trim() === activeDose)) activeDose = null;
  setNote(result.resolvedNote);
  renderCategoryFilters(result);
  showCachePill(els.searchCache, result);

  if (result.count === 0) {
    els.results.replaceChildren();
    renderDoseFilters([]);
    renderLoadMore(0, 0);
    const total = result.liczniki?.wszystkie ?? 0;
    setStatus(
      total > 0 && activeCategory !== "wszystkie"
        ? `Brak wyników w kategorii „${CATEGORY_LABELS[activeCategory]}” – wybierz „Wszystkie” (${pluralPozycja(total)}).`
        : `Brak wyników dla „${result.query}”.`,
    );
    selectedId = null;
    if (total === 0) showEmptyDetails(result.query);
    else showPlaceholder();
    return;
  }

  // Wybrany wcześniej lek nie należy do nowych wyników – nie pokazujemy nieaktualnego porównania.
  if (selectedId !== null && !result.items.some((i) => i.id === selectedId)) {
    selectedId = null;
    showPlaceholder();
  }
  renderDoseFilters(result.items);
  renderResultList();
}

function clearResults(statusText) {
  searchController?.abort();
  lastResult = null;
  activeDose = null;
  selectedId = null;
  els.results.replaceChildren();
  renderDoseFilters([]);
  renderLoadMore(0, 0);
  renderCategoryFilters(null);
  showCachePill(els.searchCache, null);
  setNote("");
  setStatus(statusText);
  showPlaceholder();
}

/* ------------------------------------------------------------------ Porównanie zamienników */

function renderDetails(data) {
  const { wybrany, zamienniki, najlepsza_oferta: best } = data;
  const cheapestPrice = zamienniki.length > 0 ? zamienniki[0].doplata_porownawcza : wybrany.doplata_pacjenta;
  const otc = isOtc(wybrany);
  const approx = otc ? "ok. " : "";

  const header = h(
    "div",
    { class: "selected-drug" },
    h(
      "div",
      null,
      h("h3", null, drugTitle(wybrany)),
      h("p", null, describeDrug(wybrany)),
      h(
        "p",
        null,
        otc
          ? h("span", { class: "tag tag-otc" }, "Bez recepty (OTC)")
          : h("span", { class: "tag tag-rp" }, "Refundowany (NFZ)"),
        otc
          ? " Orientacyjna średnia cena rynkowa"
          : ` Cena detaliczna ${pln.format(wybrany.cena_detaliczna)} · odpłatność ${wybrany.poziom_odplatnosci || "—"}`,
        wybrany.kodAtc ? ` · ATC ${wybrany.kodAtc}` : "",
      ),
    ),
    h(
      "div",
      { class: "selected-price" },
      h("span", { class: "price" }, `${approx}${pln.format(wybrany.doplata_pacjenta)}`),
      h("small", null, otc ? "Śr. cena rynkowa" : "Twoja dopłata"),
    ),
  );

  const offer = best
    ? h(
        "div",
        { class: "best-offer" },
        h("span", { class: "label" }, "Najtańsza opcja"),
        h("strong", null, `${drugTitle(best.lek)} · ${best.lek.opakowanie || ""}`.replace(/ · $/, "")),
        h(
          "span",
          { class: "amount" },
          `Oszczędzasz ${approx}${pln.format(best.oszczednosc_pln)} (${pct.format(best.oszczednosc_proc)}%)`,
        ),
        h(
          "span",
          { class: "sub" },
          `Zapłacisz ${approx}${pln.format(best.doplata_porownawcza)} zamiast ${approx}${pln.format(wybrany.doplata_pacjenta)} za opakowanie.`,
        ),
      )
    : h(
        "p",
        { class: "no-offer" },
        zamienniki.length > 1
          ? "Wybrany lek jest już najtańszy w swojej grupie zamienników."
          : otc
            ? "W bazie nie ma innych leków bez recepty o tej samej substancji czynnej, dawce i postaci."
            : "W wykazie nie ma odpowiedników o tej samej substancji czynnej, dawce i postaci.",
      );

  const rows = zamienniki.map((q) => {
    const isCheapest = q.doplata_porownawcza === cheapestPrice;
    const savingsCell = q.jest_wybranym
      ? h("td", { class: "num save-none" }, "—")
      : h(
          "td",
          { class: `num ${q.oszczednosc_pln > 0 ? "save-pos" : q.oszczednosc_pln < 0 ? "save-neg" : "save-none"}` },
          q.oszczednosc_pln === 0
            ? "0 zł"
            : `${q.oszczednosc_pln > 0 ? "" : "+"}${pln.format(Math.abs(q.oszczednosc_pln))}`,
          q.oszczednosc_pln !== 0 ? h("br") : null,
          q.oszczednosc_pln !== 0
            ? h(
                "small",
                null,
                q.oszczednosc_pln > 0
                  ? `${pct.format(q.oszczednosc_proc)}% taniej`
                  : `${pct.format(Math.abs(q.oszczednosc_proc))}% drożej`,
              )
            : null,
        );
    const classes = [q.jest_wybranym ? "is-selected" : "", isCheapest ? "is-cheapest" : ""].filter(Boolean).join(" ");
    const eanTitle = otc
      ? `EAN: ${q.lek.kod_ean || "—"} · orientacyjna cena rynkowa ${pln.format(q.lek.cena_detaliczna)}`
      : `EAN: ${q.lek.kod_ean || "—"} · cena detaliczna ${pln.format(q.lek.cena_detaliczna)}`;
    return h(
      "tr",
      { ...(classes ? { class: classes } : {}), title: eanTitle },
      h(
        "td",
        null,
        h("span", null, q.lek.nazwa),
        isCheapest ? h("span", { class: "tag tag-cheapest" }, "najtaniej") : null,
        q.jest_wybranym ? h("span", { class: "tag tag-selected" }, "wybrany") : null,
        h("br"),
        h("small", null, [q.lek.dawka, q.lek.opakowanie].filter(Boolean).join(" · ")),
      ),
      h(
        "td",
        { class: "num" },
        q.przeliczono_na_opakowanie ? `${pln.format(q.doplata_porownawcza)}*` : pln.format(q.doplata_porownawcza),
        q.przeliczono_na_opakowanie ? h("br") : null,
        q.przeliczono_na_opakowanie ? h("small", null, `za opak.: ${pln.format(q.lek.doplata_pacjenta)}`) : null,
      ),
      savingsCell,
    );
  });

  const table = h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      null,
      h("caption", null, `Grupa: ${wybrany.substancja_czynna} ${wybrany.dawka}, ${wybrany.postac}`),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col" }, "Lek i opakowanie"),
          h("th", { scope: "col", class: "num" }, otc ? "Cena ok." : "Dopłata"),
          h("th", { scope: "col", class: "num" }, "Oszczędzasz"),
        ),
      ),
      h("tbody", null, ...rows),
    ),
  );

  const notes = h(
    "p",
    { class: "note" },
    "Najedź na wiersz, aby zobaczyć kod EAN i cenę detaliczną.",
    zamienniki.some((q) => q.przeliczono_na_opakowanie)
      ? ` * – ${otc ? "cena" : "dopłata"} przeliczona na wielkość opakowania wybranego leku.`
      : "",
  );

  // Wyszukiwarka aptek trafia bezpośrednio pod boks „Najtańsza opcja” – nad (przewijaną) tabelę zamienników.
  const finderSlot = h("div", { class: "finder-slot" });
  setDetails(
    ...[
      header,
      drugInfoCard(data),
      otc ? otcNotice(wybrany) : null,
      averageBox(data),
      offer,
      finderSlot,
      table,
      notes,
    ].filter(Boolean),
  );
  finderSlot.replaceWith(els.pharmacyFinder);
  updateAvailabilityLinks(wybrany);
}

/**
 * Boks „Średnia cena w grupie” z porównaniem wybranego leku do średniej, np.
 * „Średnia cena w grupie: 14,20 zł — wybrany lek jest o 3,32 zł tańszy od średniej”.
 */
function averageBox(data) {
  const avg = Number(data.sredniaCena);
  if (!Number.isFinite(avg) || avg <= 0) return null;
  const otc = isOtc(data.wybrany);
  const diff = Number(data.roznicaDoSredniej ?? data.wybrany.doplata_pacjenta - avg);
  const count = Number(data.liczbaWGrupie ?? data.zamienniki.length);
  const priceWord = otc ? "Średnia cena rynkowa w grupie" : "Średnia cena w grupie";
  let comparison;
  let tone;
  if (count <= 1) {
    comparison = "to jedyny lek w tej grupie";
    tone = "is-even";
  } else if (Math.abs(diff) < 0.005) {
    comparison = "wybrany lek kosztuje tyle, ile wynosi średnia";
    tone = "is-even";
  } else if (diff < 0) {
    comparison = `wybrany lek jest o ${pln.format(Math.abs(diff))} tańszy od średniej`;
    tone = "is-cheaper";
  } else {
    comparison = `wybrany lek jest o ${pln.format(diff)} droższy od średniej`;
    tone = "is-pricier";
  }
  return h(
    "div",
    { class: `average-box ${tone}`, role: "note" },
    h("span", { class: "label" }, priceWord),
    h("strong", { class: "average-price" }, `${otc ? "ok. " : ""}${pln.format(avg)}`),
    h("span", { class: "average-comparison" }, `— ${comparison}`),
    h(
      "small",
      { class: "average-meta" },
      `${pluralLeki(count)} w grupie (ta sama substancja, dawka i postać); ceny przeliczone na wielkość opakowania wybranego leku.`,
    ),
  );
}

/** Informacja dla leków bez recepty: cena nieregulowana, linki do sprawdzenia aktualnej ceny. */
function otcNotice(drug) {
  const query = encodeURIComponent(drug.nazwa);
  return h(
    "div",
    { class: "otc-notice", role: "note" },
    h("span", { class: "tag tag-otc" }, "Bez recepty (OTC)"),
    h(
      "p",
      null,
      `Orientacyjna średnia cena rynkowa: ${pln.format(drug.cena_detaliczna)}. `,
      "Ceny leków bez recepty nie są regulowane ustawowo i mogą różnić się między aptekami. Sprawdź aktualną cenę w ",
      h(
        "a",
        { href: `https://ktomalek.pl/l/lek/szukaj?searchInput=${query}`, target: "_blank", rel: "noopener noreferrer" },
        "KtoMaLek",
      ),
      " lub ",
      h(
        "a",
        { href: `https://www.gdziepolek.pl/szukaj?q=${query}`, target: "_blank", rel: "noopener noreferrer" },
        "GdziePoLek",
      ),
      ".",
    ),
  );
}

/**
 * Karta „Na co pomaga i jak stosować” – opis substancji ze słownika lub opis zastępczy
 * zbudowany na serwerze z wskazania refundacyjnego i postaci leku.
 */
function drugInfoCard(data) {
  const opis = data.opisSubstancji;
  if (!opis) return null;
  const wskazanie = (data.wskazanie ?? data.wybrany.wskazanie ?? "").trim();
  const row = (label, text) => h("p", { class: "drug-info-row" }, h("strong", null, `${label}: `), text);
  return h(
    "section",
    { class: "drug-info", "aria-label": "Na co pomaga i jak stosować" },
    h("p", { class: "drug-info-kicker" }, "Na co pomaga i jak stosować"),
    h("h4", { class: "drug-info-title" }, opis.kategoria),
    row("Na co pomaga", opis.naCoPomaga),
    row("Jak stosować", opis.jakStosowac),
    wskazanie ? h("p", { class: "drug-info-official" }, `Wskazanie refundacyjne MZ: ${wskazanie}`) : null,
    opis.zrodlo === "atc"
      ? h(
          "p",
          { class: "drug-info-official" },
          `Opis grupy leków wygenerowany automatycznie na podstawie kodu ATC${data.wybrany.kodAtc ? ` (${data.wybrany.kodAtc})` : ""}.`,
        )
      : null,
    h(
      "p",
      { class: "drug-info-disclaimer" },
      "Dokładne dawkowanie zależy od wieku, masy ciała i stanu zdrowia – stosuj się do zaleceń lekarza i ulotki.",
    ),
  );
}

async function selectDrug(id) {
  selectedId = id;
  updateSelectionState();
  detailsController?.abort();
  detailsController = new AbortController();
  setDetails(h("p", { class: "placeholder" }, "Wyszukiwanie zamienników…"));
  try {
    const data = await fetchJson(`/api/equivalents?id=${encodeURIComponent(id)}`, detailsController.signal);
    renderDetails(data);
    if (window.matchMedia("(max-width: 959px)").matches) {
      els.details.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    setDetails(h("p", { class: "status error" }, error.message));
  }
}

/* ------------------------------------------------------------------ Apteki w pobliżu */

let pharmacyController = null;

/** 350 m dla odległości < 1 km, 1,4 km powyżej. */
function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${km.format(meters / 1000)} km`;
}

function readStoredLocation() {
  try {
    return localStorage.getItem(LOCATION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeLocation(value) {
  try {
    localStorage.setItem(LOCATION_STORAGE_KEY, value);
  } catch {
    // Tryb prywatny / zablokowany localStorage – zapamiętywanie adresu jest tylko udogodnieniem.
  }
}

const PRICE_NOTE_RP = ["Cena leku refundowanego jest ustawowo ", "taka sama w każdej aptece", " w Polsce."];
const PRICE_NOTE_OTC = [
  "Ceny leków bez recepty ",
  "nie są regulowane ustawowo",
  " i mogą różnić się między aptekami – porównaj aktualne ceny.",
];

/**
 * Ustawia linki „dostępność od ręki” na wyszukiwanie aktualnie wybranego leku oraz informację
 * o cenie: urzędowa (Rp – taka sama w każdej aptece) lub nieregulowana (OTC).
 * @param {{ nazwa?: string, kategoriaDostepnosci?: string } | null} drug
 */
function updateAvailabilityLinks(drug) {
  const name = (drug?.nazwa || "").trim();
  const [before, strong, after] = isOtc(drug) ? PRICE_NOTE_OTC : PRICE_NOTE_RP;
  els.pharmacyPriceNote.replaceChildren(before, h("strong", null, strong), after);
  if (!name) {
    els.pharmacyDrugLabel.textContent = "wybranego leku";
    els.ktomalekLink.href = "https://ktomalek.pl/";
    els.gdziepolekLink.href = "https://www.gdziepolek.pl/";
    return;
  }
  const encoded = encodeURIComponent(name);
  els.pharmacyDrugLabel.textContent = `leku ${name}`;
  els.ktomalekLink.href = `https://ktomalek.pl/l/lek/szukaj?searchInput=${encoded}`;
  els.gdziepolekLink.href = `https://www.gdziepolek.pl/szukaj?q=${encoded}`;
}

function setPharmacyStatus(text, isError = false) {
  els.pharmacyStatus.textContent = text;
  els.pharmacyStatus.classList.toggle("error", isError);
}

function pharmacyCard(pharmacy, isFallback = false) {
  return h(
    "li",
    { class: `pharmacy-card${isFallback ? " is-fallback" : ""}` },
    h(
      "div",
      { class: "pharmacy-head" },
      h(
        "strong",
        { class: "pharmacy-name" },
        pharmacy.name,
        isFallback ? h("span", { class: "tag tag-example" }, "przykład") : null,
      ),
      h("span", { class: "distance-pill" }, `${isFallback ? "ok. " : ""}${formatDistance(pharmacy.distanceMeters)}`),
    ),
    pharmacy.address ? h("p", { class: "pharmacy-address" }, pharmacy.address) : null,
    pharmacy.openingHours ? h("p", { class: "pharmacy-hours" }, `Godziny otwarcia: ${pharmacy.openingHours}`) : null,
    h(
      "a",
      {
        class: "navigate-btn",
        href: pharmacy.navigationUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": isFallback
          ? "Szukaj prawdziwych aptek w okolicy w Mapach Google"
          : `Nawiguj do: ${pharmacy.name}${pharmacy.address ? `, ${pharmacy.address}` : ""}`,
      },
      isFallback ? "Szukaj w Mapach" : "Nawiguj",
    ),
  );
}

async function searchPharmacies(query) {
  const q = query.trim();
  if (q.length < 3) {
    setPharmacyStatus("Wpisz co najmniej 3 znaki kodu pocztowego lub adresu.", true);
    return;
  }
  storeLocation(q);
  pharmacyController?.abort();
  pharmacyController = new AbortController();
  setPharmacyStatus("");
  showCachePill(els.pharmacyCache, null);
  els.pharmacyList.setAttribute("aria-busy", "true");
  // Etapy odpowiadają krokom serwera: geokodowanie (Nominatim) → Overpass (do 3 serwerów po 8 s).
  pharmacyProgress.start(
    [
      { at: 0, percent: 10, text: "Łączenie z serwerem…" },
      { at: 150, percent: 25, text: "Wyszukiwanie współrzędnych adresu…" },
      { at: 1100, percent: 65, text: "Pobieranie aptek z OpenStreetMap…" },
      { at: 9000, percent: 75, text: "Pobieranie aptek z OpenStreetMap (serwer zapasowy)…" },
      { at: 17000, percent: 85, text: "Pobieranie aptek z OpenStreetMap (ostatni serwer zapasowy)…" },
    ],
    { creepTo: 95 },
  );
  try {
    const result = await fetchJson(`/api/pharmacies?${new URLSearchParams({ q })}`, pharmacyController.signal, {
      metrics: false,
      fresh: true,
    });
    const fallback = result.isFallback === true;
    pharmacyProgress.done(fallback ? "Gotowe (tryb awaryjny)" : "Gotowe");
    els.pharmacyList.replaceChildren(...result.pharmacies.map((p) => pharmacyCard(p, fallback)));
    els.pharmacySummary.textContent = fallback
      ? `Przykładowe apteki w okolicy (${result.pharmacies.length})`
      : `Znalezione apteki (${result.pharmacies.length})`;
    els.pharmacyResults.hidden = result.pharmacies.length === 0;
    els.pharmacyResults.open = true;
    els.pharmacyResults.classList.toggle("is-fallback", fallback);
    showCachePill(els.pharmacyCache, result);
    const radius = formatDistance(result.radiusMeters);
    if (fallback) {
      setPharmacyStatus(result.fallbackReason || "Tryb awaryjny – serwery map nie odpowiadają.", true);
    } else {
      setPharmacyStatus(
        result.pharmacies.length > 0
          ? `Najbliższe apteki (do ${radius}) od: ${result.resolvedLocation.displayName}`
          : `Brak aptek w promieniu ${radius} od: ${result.resolvedLocation.displayName}`,
      );
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    pharmacyProgress.fail();
    els.pharmacyList.replaceChildren();
    els.pharmacyResults.hidden = true;
    setPharmacyStatus(error.message || "Nie udało się wyszukać aptek.", true);
  } finally {
    els.pharmacyList.removeAttribute("aria-busy");
  }
}

els.pharmacyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchPharmacies(els.pharmacyInput.value);
});

const storedLocation = readStoredLocation();
if (storedLocation) {
  els.pharmacyInput.value = storedLocation;
  searchPharmacies(storedLocation);
}

/* ------------------------------------------------------------------ Wyszukiwanie */

/**
 * Wyszukiwanie; `more: true` (przycisk „Pokaż więcej wyników”) zachowuje powiększony limit,
 * każde inne wywołanie (nowa fraza, zmiana kategorii) wraca do pierwszych RESULT_LIMIT pozycji.
 */
async function runSearch(query, { more = false } = {}) {
  searchController?.abort();
  if (!more) resultLimit = RESULT_LIMIT;
  const q = query.trim();
  const url = new URL(window.location.href);
  if (q) url.searchParams.set("q", q);
  else url.searchParams.delete("q");
  if (activeCategory !== "wszystkie") url.searchParams.set("kategoria", activeCategory);
  else url.searchParams.delete("kategoria");
  history.replaceState(null, "", url);

  if (q.length < MIN_QUERY_LENGTH) {
    clearResults(q.length === 0 ? "Zacznij pisać, aby wyszukać lek." : "Wpisz co najmniej 2 znaki.");
    return;
  }

  searchController = new AbortController();
  setStatus("Wyszukiwanie…");
  // Pasek pojawia się dopiero po 150 ms – szybkie odpowiedzi (z cache, kilka ms) nie migają.
  searchProgress.start(
    [
      { at: 0, percent: 30, text: "Wyszukiwanie w bazie leków…" },
      { at: 600, percent: 70, text: "Dopasowywanie nazw, substancji i zamienników…" },
    ],
    { delay: 150 },
  );
  try {
    const params = new URLSearchParams({ q, limit: String(Math.min(resultLimit, maxResultLimit)) });
    if (activeCategory !== "wszystkie") params.set("kategoria", activeCategory);
    const result = await fetchJson(`/api/search?${params}`, searchController.signal, { fresh: true });
    searchProgress.done();
    renderResults(result, { more });
  } catch (error) {
    if (error.name === "AbortError") return;
    searchProgress.fail();
    clearResults("");
    setStatus(error.message || "Nie udało się połączyć z serwerem.", true);
  }
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const health = await response.json();
    els.appVersion.textContent = health.version;
    if (Number.isInteger(health.search_max_limit) && health.search_max_limit > 0) {
      maxResultLimit = health.search_max_limit;
    }
    els.perfRows.textContent = pluralLeki(health.rows);
    const isDemo = health.data.source === "fallback-demo";
    els.demoBanner.hidden = !isDemo;
    const built = new Date(health.data.built_at);
    const when = Number.isNaN(built.getTime()) ? "" : `, zbudowano ${built.toLocaleString("pl-PL")}`;
    const split =
      typeof health.data.rows_rp === "number"
        ? `: ${int.format(health.data.rows_rp)} refundowanych, ${int.format(health.data.rows_otc ?? 0)} bez recepty`
        : "";
    els.dataSource.textContent = isDemo
      ? `próbka demonstracyjna (${int.format(health.rows)} pozycji${split})`
      : `${health.data.resource_title || "wykaz leków refundowanych"} (${int.format(health.rows)} pozycji${split}${when})`;
  } catch {
    els.dataSource.textContent = "niedostępne";
    els.perfRows.textContent = "baza niedostępna";
  }
}

const debouncedSearch = debounce(runSearch, DEBOUNCE_MS);

els.input.addEventListener("input", () => debouncedSearch(els.input.value));
els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(els.input.value);
});

for (const pill of document.querySelectorAll(".quick-pills .pill")) {
  pill.addEventListener("click", () => {
    els.input.value = pill.dataset.q || "";
    els.input.focus();
    runSearch(els.input.value);
  });
}

loadHealth();

const initialParams = new URL(window.location.href).searchParams;
const initialCategory = initialParams.get("kategoria");
if (initialCategory === "Rp" || initialCategory === "OTC") activeCategory = initialCategory;
const initial = initialParams.get("q");
if (initial) {
  els.input.value = initial;
  runSearch(initial);
}
