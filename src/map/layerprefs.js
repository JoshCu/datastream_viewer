// ====================================================================
// The map's layer toggle buttons (terrain, hillshade, flowpaths,
// catchments, gages, gage labels): where their state starts, and where it's
// recorded.
//
// Starting state: the URL's `layers=` (the keys that are on) when present,
// else the last-used settings in localStorage, else LAYER_DEFAULTS.
//
// Every change, from a click or from code (the context menu's upstream
// highlight turning catchments on, the flood panel turning terrain on), is
// written to the URL so a link reproduces the view. Only a click on the
// button is saved to localStorage, and only for that button: opening a link
// with other settings doesn't overwrite the last-used ones until you
// change something yourself.
// ====================================================================
import { setUrlParam } from "../ui/url.js";

const STORAGE_KEY = "layerToggles";

// Also the URL's key order.
export const LAYER_DEFAULTS = {
  terrain: false,
  hillshade: false,
  flowpaths: true,
  catchments: false,
  gages: true,
  labels: false,
};

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has("layers")) return null;
  const on = new Set(p.get("layers").split(",").filter(Boolean));
  return Object.fromEntries(Object.keys(LAYER_DEFAULTS).map((k) => [k, on.has(k)]));
}

const initial = readUrl() ?? { ...LAYER_DEFAULTS, ...readSaved() };
const current = { ...initial };

export function initialLayer(key) {
  return initial[key] === true;
}

// Record a layer's state in the URL.
export function noteLayer(key, on) {
  if (current[key] === on) return;
  current[key] = on;
  writeUrl();
}

// A click on the layer's button: record it and remember it as last used.
export function saveLayer(key, on) {
  noteLayer(key, on);
  const saved = readSaved();
  saved[key] = on;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or blocked: the URL still has it.
  }
}

export function writeUrl() {
  const on = Object.keys(LAYER_DEFAULTS).filter((k) => current[k]);
  setUrlParam("layers", on.join(","));
}
