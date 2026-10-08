// ====================================================================
// The catalog gage layer: every USGS site with a continuous record
// (data/usgscatalog.js), always on the map, coloured and filtered by what it
// observes. Independent of the loaded run — the run's own gages
// (map/gages.js) are drawn as white dots over these.
//
// Each feature carries two observation-type bitmasks, `m` (ever) and `a`
// (reporting within USGS_ACTIVE_WINDOW_MS). Toggling a type or "active only"
// only rebuilds the filter and colour expressions; the data is set once per
// catalog install.
// ====================================================================
import { map } from "../state.js";
import {
  HIDDEN_FILTER,
  USGS_OBS_TYPES,
  USGS_SITES_SOURCE,
  USGS_SITES_LAYER,
  USGS_SITES_LABEL_LAYER,
} from "../config.js";
import { onCatalogChange, getCatalog } from "../data/usgscatalog.js";

const SETTINGS_KEY = "usgs-sites-settings";
const listeners = new Set();

// Which types are shown, and whether only reporting sites are. Persisted, so
// a hidden type stays hidden across visits.
const settings = loadSettings();

function loadSettings() {
  const defaults = { hidden: [], activeOnly: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
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

export function activeOnly() {
  return settings.activeOnly;
}

// fn() whenever the type toggles or the active-only switch change.
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

export function setActiveOnly(on) {
  settings.activeOnly = on;
  changed();
}

function changed() {
  saveSettings();
  applyStyle();
  for (const fn of listeners) fn();
}

// ---- Expressions ----------------------------------------------------------

// Bit `i` of the mask property (MapLibre expressions have no bitwise ops).
function hasType(prop, i) {
  return ["==", ["%", ["floor", ["/", ["get", prop], 2 ** i]], 2], 1];
}

function shownTypes() {
  return USGS_OBS_TYPES.map((_, i) => i).filter(isTypeShown);
}

export function siteFilter() {
  const prop = settings.activeOnly ? "a" : "m";
  const shown = shownTypes();
  return shown.length ? ["any", ...shown.map((i) => hasType(prop, i))] : HIDDEN_FILTER;
}

// The colour of the first shown type the site has (types are in priority
// order), so hiding "Discharge" recolours discharge gages by what's left.
function siteColor() {
  const prop = settings.activeOnly ? "a" : "m";
  const cases = shownTypes().flatMap((i) => [hasType(prop, i), USGS_OBS_TYPES[i].color]);
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

function toGeoJSON(catalog) {
  return {
    type: "FeatureCollection",
    features: catalog.sites.map((s) => ({
      type: "Feature",
      properties: { id: s.id, no: s.no, m: s.mask, a: s.activeMask },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  };
}

let installedFor = null;
function applyData() {
  const catalog = getCatalog();
  const source = map?.getSource(USGS_SITES_SOURCE);
  if (!catalog || !source || installedFor === catalog) return;
  installedFor = catalog;
  source.setData(toGeoJSON(catalog));
  applyStyle();
}

// Called once from map/init.js. The catalog can land (from IndexedDB) before
// the style has its source, so both orders end in applyData().
export function setupUsgsSites() {
  onCatalogChange(applyData);
  if (map.getSource(USGS_SITES_SOURCE)) applyData();
  else map.once("load", applyData);
}
