// ====================================================================
// Hydrologic unit boundaries: one line layer per level over the huc.pmtiles
// source, each its own toggle in map/layerprefs.js. The layers themselves are
// in map/basemap-style.js; the panel is ui/hucpanel.js.
// ====================================================================
import { map } from "../state.js";
import { HIDDEN_FILTER, HUC_LEVELS, hucFillLayer, hucLineLayer, hucSearchLayer } from "../config.js";
import { layerOn, noteLayer } from "./layerprefs.js";

function apply(key) {
  if (!map?.getLayer(hucLineLayer(key))) return; // on load, once the style has it
  const visibility = layerOn(key) ? "visible" : "none";
  map.setLayoutProperty(hucLineLayer(key), "visibility", visibility);
  map.setLayoutProperty(hucFillLayer(key), "visibility", visibility);
}

// Doesn't save: only a click in the panel does (map/layerprefs.js).
export function setHucLevel(key, on) {
  noteLayer(key, on);
  apply(key);
}

export function shownHucLevels() {
  return HUC_LEVELS.filter(({ key }) => layerOn(key));
}

// The units under a screen point, one per shown level, coarsest first:
// [{ level, huc, name }]. A unit with no name in the tiles has its code as `name`.
export function hucAt(point) {
  const shown = shownHucLevels();
  if (!shown.length) return [];
  const hits = map.queryRenderedFeatures(point, {
    layers: shown.map(({ key }) => hucFillLayer(key)),
  });
  return shown.flatMap((level) => {
    const hit = hits.find((f) => f.sourceLayer === level.key);
    return hit ? [{ level, huc: hit.properties.huc, name: hit.properties.name }] : [];
  });
}

let markedKey = null;

// Outline one unit for the search box (level key + code), or none with no
// arguments. Separate from the level toggles: it shows with them all off.
export function markHuc(key = null, huc = null) {
  if (markedKey) {
    map.setLayoutProperty(hucSearchLayer(markedKey), "visibility", "none");
    map.setFilter(hucSearchLayer(markedKey), HIDDEN_FILTER);
  }
  markedKey = key;
  if (!key) return;
  map.setFilter(hucSearchLayer(key), ["==", ["get", "huc"], huc]);
  map.setLayoutProperty(hucSearchLayer(key), "visibility", "visible");
}

// Called once from map/init.js, before the style has loaded.
export function setupHuc() {
  map.once("load", () => HUC_LEVELS.forEach(({ key }) => apply(key)));
}
