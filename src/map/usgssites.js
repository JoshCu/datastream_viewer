// ====================================================================
// The catalog gage layer: every USGS site with a continuous record
// (data/usgscatalog.js), always on the map, coloured and filtered by what it
// observes. Independent of the loaded run — the run's own gages
// (map/gages.js) are drawn as white dots over these.
//
// Which of a site's series count is decided here, per series: the period
// (reporting recently / any time / overlapping or spanning a date range) and
// a minimum record length; a drainage-area range then applies per site.
// Each feature carries `f`, the observation-type bitmask of its series that
// pass, so toggling a type only rebuilds the filter and colour expressions,
// while a period/area change recomputes `f` and resets the source data.
// ====================================================================
import { map } from "../state.js";
import {
  HIDDEN_FILTER,
  USGS_OBS_TYPES,
  USGS_ACTIVE_WINDOW_MS,
  USGS_SITES_SOURCE,
  USGS_SITES_LAYER,
  USGS_SITES_LABEL_LAYER,
} from "../config.js";
import { onCatalogChange, getCatalog } from "../data/usgscatalog.js";

const SETTINGS_KEY = "usgs-sites-settings";
const DAY_MS = 86400000;
const YEAR_MS = 365.25 * DAY_MS;
const listeners = new Set();

// Which types are shown and which series count. Persisted, so a hidden type
// stays hidden across visits.
//   period: "recent" (reporting within USGS_ACTIVE_WINDOW_MS) | "all" | "range"
//   from, to: "YYYY-MM-DD" or "" (open), used when period is "range"
//   cover: the series must span the whole range, not just touch it
//   minYears: minimum begin-to-end length of a series (0 = any)
//   minArea, maxArea: drainage area bounds in mi² (null = open); a site with
//     no drainage area fails once either is set
const settings = loadSettings();

function loadSettings() {
  const defaults = { hidden: [], period: "recent", from: "", to: "", cover: false, minYears: 0, minArea: null, maxArea: null };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    // Before periods there was only the "active only" switch.
    if (saved.period === undefined && saved.activeOnly === false) saved.period = "all";
    delete saved.activeOnly;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the toggles still work for this session.
  }
}

export function isTypeShown(i) {
  return !settings.hidden.includes(USGS_OBS_TYPES[i].key);
}

// { period, from, to, cover, minYears, minArea, maxArea }, for the panel.
export function periodSettings() {
  const { period, from, to, cover, minYears, minArea, maxArea } = settings;
  return { period, from, to, cover, minYears, minArea, maxArea };
}

// fn() whenever the type toggles or the period settings change.
export function onSiteFilterChange(fn) {
  listeners.add(fn);
}

export function setTypeShown(i, shown) {
  const key = USGS_OBS_TYPES[i].key;
  settings.hidden = settings.hidden.filter((k) => k !== key);
  if (!shown) settings.hidden.push(key);
  changed();
}

export function setAllTypesShown(shown) {
  settings.hidden = shown ? [] : USGS_OBS_TYPES.map((t) => t.key);
  changed();
}

// Any subset of { period, from, to, cover, minYears, minArea, maxArea }.
export function setPeriod(patch) {
  Object.assign(settings, patch);
  settings.minYears = Math.max(0, Number(settings.minYears) || 0);
  settings.minArea = bound(settings.minArea);
  settings.maxArea = bound(settings.maxArea);
  changed();
}

// A non-negative number, or null for blank/invalid.
function bound(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function changed() {
  saveSettings();
  applyData();
  applyStyle();
  for (const fn of listeners) fn();
}

// ---- Which series count ---------------------------------------------------

function dayMs(text) {
  const ms = text ? Date.parse(text) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

// Everything the period and area settings change, as a cache key.
function periodKey() {
  const { period, from, to, cover, minYears, minArea, maxArea } = settings;
  const range = period === "range" ? `${from}|${to}|${cover}` : "";
  return `${period}|${range}|${minYears}|${minArea}|${maxArea}`;
}

let maskCache = { catalog: null, key: "", masks: null };

// Per catalog site (same order as catalog.sites), the bitmask of observation
// types with at least one series passing the period settings (0 for a site
// outside the drainage-area range). Null before
// the catalog has loaded.
export function filteredMasks() {
  const catalog = getCatalog();
  if (!catalog) return null;
  const key = periodKey();
  if (maskCache.catalog === catalog && maskCache.key === key) return maskCache.masks;

  const { params, sites, fetchedAt } = catalog;
  const since = settings.period === "recent" ? fetchedAt - USGS_ACTIVE_WINDOW_MS : null;
  const range = settings.period === "range";
  const from = range ? dayMs(settings.from) : null;
  const cover = settings.cover;
  // `to` is inclusive. A series that's still reporting ends "a few hours
  // ago", so when spanning a range that reaches today, reporting counts.
  let to = range ? dayMs(settings.to) : null;
  if (to != null) to += DAY_MS - 1;
  if (to != null && cover) to = Math.min(to, fetchedAt - USGS_ACTIVE_WINDOW_MS);
  const minMs = settings.minYears * YEAR_MS;
  const ranged = from != null || to != null;
  const { minArea, maxArea } = settings;
  const areaBound = minArea != null || maxArea != null;

  const masks = new Uint16Array(sites.length);
  sites.forEach((site, i) => {
    if (areaBound) {
      const area = site.area;
      if (area == null || (minArea != null && area < minArea) || (maxArea != null && area > maxArea)) return;
    }
    let mask = 0;
    for (const [p, begin, end] of site.series) {
      if (since != null && !(end != null && end >= since)) continue;
      if ((minMs || ranged) && (begin == null || end == null)) continue;
      if (minMs && end - begin < minMs) continue;
      if (ranged) {
        const out = cover
          ? (from != null && begin > from) || (to != null && end < to)
          : (to != null && begin > to) || (from != null && end < from);
        if (out) continue;
      }
      mask |= 1 << params[p].type;
    }
    masks[i] = mask;
  });
  maskCache = { catalog, key, masks };
  return masks;
}

// The sites on the map: those with a shown type among their filtered ones,
// each with that subset as `types` (indices into USGS_OBS_TYPES).
export function shownSites() {
  const masks = filteredMasks();
  if (!masks) return [];
  const shown = shownTypes();
  const out = [];
  getCatalog().sites.forEach((site, i) => {
    const types = shown.filter((t) => masks[i] & (1 << t));
    if (types.length) out.push({ site, types });
  });
  return out;
}

// ---- Expressions ----------------------------------------------------------

// Bit `i` of the site's filtered mask (MapLibre expressions have no bitwise ops).
function hasType(i) {
  return ["==", ["%", ["floor", ["/", ["get", "f"], 2 ** i]], 2], 1];
}

function shownTypes() {
  return USGS_OBS_TYPES.map((_, i) => i).filter(isTypeShown);
}

export function siteFilter() {
  const shown = shownTypes();
  return shown.length ? ["any", ...shown.map(hasType)] : HIDDEN_FILTER;
}

// The colour of the first shown type the site has (types are in priority
// order), so hiding "Discharge" recolours discharge gages by what's left.
function siteColor() {
  const cases = shownTypes().flatMap((i) => [hasType(i), USGS_OBS_TYPES[i].color]);
  return cases.length ? ["case", ...cases, "#888888"] : "#888888";
}

function applyStyle() {
  if (!map?.getLayer(USGS_SITES_LAYER)) return;
  const filter = siteFilter();
  map.setFilter(USGS_SITES_LAYER, filter);
  map.setFilter(USGS_SITES_LABEL_LAYER, filter);
  map.setPaintProperty(USGS_SITES_LAYER, "circle-color", siteColor());
}

// ---- Data -----------------------------------------------------------------

function toGeoJSON(catalog, masks) {
  return {
    type: "FeatureCollection",
    features: catalog.sites.map((s, i) => ({
      type: "Feature",
      properties: { id: s.id, no: s.no, f: masks[i] },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  };
}

// Reset the source when the catalog or the period settings have changed
// since it was last set.
let installedFor = null;
function applyData() {
  const catalog = getCatalog();
  const source = map?.getSource(USGS_SITES_SOURCE);
  if (!catalog || !source) return;
  const masks = filteredMasks();
  if (installedFor === masks) return;
  installedFor = masks;
  source.setData(toGeoJSON(catalog, masks));
  applyStyle();
}

// Called once from map/init.js. The catalog can land (from IndexedDB) before
// the style has its source, so both orders end in applyData().
export function setupUsgsSites() {
  onCatalogChange(applyData);
  if (map.getSource(USGS_SITES_SOURCE)) applyData();
  else map.once("load", applyData);
}
