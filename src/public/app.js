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
  details: $("details"),
  perfPill: $("perf-pill"),
  perfDb: $("perf-db"),
  perfRows: $("perf-rows"),
  perfDetails: $("perf-details"),
  demoBanner: $("demo-banner"),
  dataSource: $("data-source"),
  appVersion: $("app-version"),
  pharmacyForm: $("pharmacy-form"),
  pharmacyInput: $("pharmacy-q"),
  pharmacyStatus: $("pharmacy-status"),
  pharmacyList: $("pharmacy-list"),
  pharmacyDrugLabel: $("pharmacy-drug-label"),
  ktomalekLink: $("ktomalek-link"),
  gdziepolekLink: $("gdziepolek-link"),
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

async function fetchJson(url, signal, { metrics = true } = {}) {
  const started = performance.now();
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
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

function drugTitle(drug) {
  return [drug.nazwa, drug.dawka].filter(Boolean).join(" ");
}

function describeDrug(drug) {
  return [drug.substancja_czynna, drug.postac, drug.opakowanie].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------ Panel szczegółów */

function showPlaceholder() {
  detailsController?.abort();
  els.details.replaceChildren(h("p", { class: "placeholder" }, PLACEHOLDER_TEXT));
  updateAvailabilityLinks("");
}

function showEmptyDetails(query) {
  detailsController?.abort();
  els.details.replaceChildren(
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
    const key = [item.nazwa, item.dawka, item.postac].map((v) => (v || "").trim().toLowerCase()).join("\u0000");
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
  const level = shortLevel(variant.poziom_odplatnosci);
  const sizeLabel = duplicated && level ? `${size} (${level})` : size;
  return `${sizeLabel} • ${pln.format(variant.doplata_pacjenta)}`;
}

function resultCard(variants) {
  // Warianty są posortowane od najtańszego – pierwszy jest domyślnym wariantem karty.
  const [cheapest] = variants;
  const ids = variants.map((v) => v.id);
  const maxSaving = Math.max(...variants.map((v) => v.mozliwa_oszczednosc || 0));
  const hasEquivalents = variants.some((v) => v.liczba_zamiennikow > 0);
  const extra =
    maxSaving > 0
      ? h("span", { class: "badge-save" }, `Oszczędź do ${pln.format(maxSaving)}`)
      : hasEquivalents
        ? h("span", { class: "badge-muted" }, "Najtańszy w grupie")
        : null;
  const priceText =
    variants.length > 1 ? `od ${pln.format(cheapest.doplata_pacjenta)}` : pln.format(cheapest.doplata_pacjenta);
  const meta = [cheapest.substancja_czynna, cheapest.postac].filter(Boolean).join(" · ");

  const button = h(
    "button",
    {
      type: "button",
      class: "result-btn",
      "aria-pressed": String(ids.includes(selectedId)),
      "data-ids": ids.join(","),
      title: `Najniższa dopłata pacjenta: ${pln.format(cheapest.doplata_pacjenta)}`,
    },
    h(
      "span",
      { class: "result-name" },
      cheapest.nazwa,
      cheapest.dawka ? h("span", { class: "dose" }, cheapest.dawka) : null,
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
        title: `${variant.opakowanie || "Opakowanie"} · odpłatność ${variant.poziom_odplatnosci || "—"} · EAN ${variant.kod_ean || "—"}`,
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
  const suffix = activeDose ? ` · dawka ${activeDose}` : "";
  const packs = groups.length !== items.length ? ` (${pluralOpakowanie(items.length)})` : "";
  setStatus(`${pluralPozycja(groups.length)}${packs}${suffix}`);
}

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

function renderResults(result) {
  lastResult = result;
  activeDose = null;
  setNote(result.resolvedNote);

  if (result.count === 0) {
    els.results.replaceChildren();
    renderDoseFilters([]);
    setStatus(`Brak wyników dla „${result.query}”.`);
    selectedId = null;
    showEmptyDetails(result.query);
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
  setNote("");
  setStatus(statusText);
  showPlaceholder();
}

/* ------------------------------------------------------------------ Porównanie zamienników */

function renderDetails(data) {
  const { wybrany, zamienniki, najlepsza_oferta: best } = data;
  const cheapestPrice = zamienniki.length > 0 ? zamienniki[0].doplata_porownawcza : wybrany.doplata_pacjenta;

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
        `Cena detaliczna ${pln.format(wybrany.cena_detaliczna)} · odpłatność ${wybrany.poziom_odplatnosci || "—"}`,
      ),
    ),
    h(
      "div",
      { class: "selected-price" },
      h("span", { class: "price" }, pln.format(wybrany.doplata_pacjenta)),
      h("small", null, "Twoja dopłata"),
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
          `Oszczędzasz ${pln.format(best.oszczednosc_pln)} (${pct.format(best.oszczednosc_proc)}%)`,
        ),
        h(
          "span",
          { class: "sub" },
          `Zapłacisz ${pln.format(best.doplata_porownawcza)} zamiast ${pln.format(wybrany.doplata_pacjenta)} za opakowanie.`,
        ),
      )
    : h(
        "p",
        { class: "no-offer" },
        zamienniki.length > 1
          ? "Wybrany lek jest już najtańszy w swojej grupie zamienników."
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
    const eanTitle = `EAN: ${q.lek.kod_ean || "—"} · cena detaliczna ${pln.format(q.lek.cena_detaliczna)}`;
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
          h("th", { scope: "col", class: "num" }, "Dopłata"),
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
      ? " * – dopłata przeliczona na wielkość opakowania wybranego leku."
      : "",
  );

  els.details.replaceChildren(...[header, drugInfoCard(data), offer, table, notes].filter(Boolean));
  updateAvailabilityLinks(wybrany.nazwa);
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
  els.details.replaceChildren(h("p", { class: "placeholder" }, "Wyszukiwanie zamienników…"));
  try {
    const data = await fetchJson(`/api/equivalents?id=${encodeURIComponent(id)}`, detailsController.signal);
    renderDetails(data);
    if (window.matchMedia("(max-width: 959px)").matches) {
      els.details.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    els.details.replaceChildren(h("p", { class: "status error" }, error.message));
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

/** Ustawia linki „dostępność od ręki” na wyszukiwanie aktualnie wybranego leku. */
function updateAvailabilityLinks(drugName) {
  const name = (drugName || "").trim();
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

function pharmacyCard(pharmacy) {
  return h(
    "li",
    { class: "pharmacy-card" },
    h(
      "div",
      { class: "pharmacy-head" },
      h("strong", { class: "pharmacy-name" }, pharmacy.name),
      h("span", { class: "distance-pill" }, formatDistance(pharmacy.distanceMeters)),
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
        "aria-label": `Nawiguj do: ${pharmacy.name}${pharmacy.address ? `, ${pharmacy.address}` : ""}`,
      },
      "Nawiguj",
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
  setPharmacyStatus("Szukam aptek w pobliżu… (publiczne mapy OpenStreetMap mogą odpowiadać do kilkudziesięciu sekund)");
  els.pharmacyList.setAttribute("aria-busy", "true");
  try {
    const result = await fetchJson(`/api/pharmacies?${new URLSearchParams({ q })}`, pharmacyController.signal, {
      metrics: false,
    });
    els.pharmacyList.replaceChildren(...result.pharmacies.map(pharmacyCard));
    const radius = formatDistance(result.radiusMeters);
    setPharmacyStatus(
      result.pharmacies.length > 0
        ? `Najbliższe apteki (do ${radius}) od: ${result.resolvedLocation.displayName}`
        : `Brak aptek w promieniu ${radius} od: ${result.resolvedLocation.displayName}`,
    );
  } catch (error) {
    if (error.name === "AbortError") return;
    els.pharmacyList.replaceChildren();
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

async function runSearch(query) {
  searchController?.abort();
  const q = query.trim();
  const url = new URL(window.location.href);
  if (q) url.searchParams.set("q", q);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);

  if (q.length < MIN_QUERY_LENGTH) {
    clearResults(q.length === 0 ? "Zacznij pisać, aby wyszukać lek." : "Wpisz co najmniej 2 znaki.");
    return;
  }

  searchController = new AbortController();
  setStatus("Wyszukiwanie…");
  try {
    const params = new URLSearchParams({ q, limit: String(RESULT_LIMIT) });
    const result = await fetchJson(`/api/search?${params}`, searchController.signal);
    renderResults(result);
  } catch (error) {
    if (error.name === "AbortError") return;
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
    els.perfRows.textContent = pluralLeki(health.rows);
    const isDemo = health.data.source === "fallback-demo";
    els.demoBanner.hidden = !isDemo;
    const built = new Date(health.data.built_at);
    const when = Number.isNaN(built.getTime()) ? "" : `, zbudowano ${built.toLocaleString("pl-PL")}`;
    els.dataSource.textContent = isDemo
      ? `próbka demonstracyjna (${health.rows} pozycji)`
      : `${health.data.resource_title || "wykaz leków refundowanych"} (${health.rows} pozycji${when})`;
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

const initial = new URL(window.location.href).searchParams.get("q");
if (initial) {
  els.input.value = initial;
  runSearch(initial);
}
