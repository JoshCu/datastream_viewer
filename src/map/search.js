// ====================================================================
// Map search: type cat-N (or wb-N, or just N) and the map flies there,
// outlines it, and opens its forcings when a forcing source is set; type a
// USGS site number (or USGS-N) and it flies to that gage and rings it.
//
// A catchment in a divides tile that's already loaded is framed from its
// geometry straight away. Anything else is looked up in the hydrofabric
// index (data/workers/hfindex.js): its id column is scanned once per session
// (~10 MB of range reads) into a sorted table kept here, then each search
// reads just that catchment's coordinates.
//
// A gage in loaded gage tiles is placed from them; anything else from the
// USGS station metadata (data/usgs.js), which works for gages the
// hydrofabric doesn't carry too.
// ====================================================================
import { state, map } from "../state.js";
import {
  DIVIDE_FEATURE,
  GAGE_FEATURE,
  GAGE_URI_PREFIX,
  HIDDEN_FILTER,
  SEARCH_LAYER,
  SEARCH_POINT_SOURCE,
} from "../config.js";
import { runTask } from "../data/loader.js";
import { fetchGageMeta } from "../data/usgs.js";
import { hasForcingSource } from "../forcing/loader.js";
import { openForcingPlot } from "../ui/forcingplot.js";
import { showGageInfo } from "../ui/gagepanel.js";
import { iconButton } from "../ui/dom.js";
import { sidebarFitOffset } from "./paint.js";

// Close enough to see the catchment's outline when only its point is known.
const POINT_ZOOM = 11;
const GAGE_ZOOM = 12;
const FIT_OPTIONS = { padding: 80, maxZoom: 13 };

let indexPromise = null; // Promise<{ nums, rows }>
let searchSeq = 0; // a newer search abandons an older one's camera move

// What a search box entry asks for:
//   "cat-123", "wb-123", "123"            -> { catchment: 123 }
//   "USGS-01013500", "gages-…", "01013500" -> { site: "01013500" }
// or null. wb-N drains cat-N in this hydrofabric, so a reach id finds its
// catchment. USGS site numbers are 8–15 digits and catchment ids stay under
// 8, so a bare number that long is a gage.
export function parseSearch(text) {
  const gage = /^\s*(?:(?:usgs|gages?)[-_ ]?)?(\d{8,15})\s*$/i.exec(text);
  if (gage) return { site: gage[1] };
  const cat = /^\s*(?:(?:cat|wb)[-_ ]?)?(\d+)\s*$/i.exec(text);
  return cat ? { catchment: Number(cat[1]) } : null;
}

function catchmentIndex() {
  if (!indexPromise) {
    indexPromise = runTask({ type: "hfIndex" });
    indexPromise.catch(() => {
      indexPromise = null;
    });
  }
  return indexPromise;
}

function indexRowOf({ nums, rows }, num) {
  let lo = 0;
  let hi = nums.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nums[mid] < num) lo = mid + 1;
    else if (nums[mid] > num) hi = mid - 1;
    else return rows[mid];
  }
  return -1;
}

// Bounds of the catchment from loaded divides tiles, or null. Pieces from
// several tiles (it's clipped at tile edges) are unioned.
function loadedBounds(num) {
  const features = map.querySourceFeatures(DIVIDE_FEATURE.source, {
    sourceLayer: DIVIDE_FEATURE.sourceLayer,
    filter: ["==", ["id"], num],
  });
  if (!features.length) return null;
  const bounds = new maplibregl.LngLatBounds();
  for (const f of features) {
    const { type, coordinates } = f.geometry;
    const polygons = type === "MultiPolygon" ? coordinates : [coordinates];
    for (const polygon of polygons) {
      for (const ring of polygon) for (const xy of ring) bounds.extend(xy);
    }
  }
  return bounds;
}

// Where the catchment is: { bounds } from tiles, or { center } from the
// index. Null when the id isn't in the hydrofabric.
async function locate(num) {
  const bounds = loadedBounds(num);
  if (bounds) return { bounds };
  const row = indexRowOf(await catchmentIndex(), num);
  if (row < 0) return null;
  const { lon, lat } = await runTask({ type: "hfIndexRow", row });
  return { center: [lon, lat] };
}

function setSearchPoint(lonLat) {
  map.getSource(SEARCH_POINT_SOURCE)?.setData({
    type: "FeatureCollection",
    features: lonLat
      ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lonLat } }]
      : [],
  });
}

function clearMarks() {
  if (map.getLayer(SEARCH_LAYER)) map.setFilter(SEARCH_LAYER, HIDDEN_FILTER);
  setSearchPoint(null);
}

export function clearSearch() {
  searchSeq++;
  clearMarks();
}

// Find cat-`num`, fly to it and outline it. Resolves false if it doesn't
// exist; `onStatus` gets progress text for the slow (index) path.
export async function searchCatchment(num, onStatus = () => {}) {
  const seq = ++searchSeq;
  if (!loadedBounds(num)) {
    onStatus(indexPromise ? "Looking up…" : "Loading the catchment index…");
  }
  const where = await locate(num);
  if (seq !== searchSeq) return true;
  if (!where) return false;

  clearMarks();
  map.setFilter(SEARCH_LAYER, ["==", ["id"], num]);
  const offset = sidebarFitOffset();
  if (where.bounds) map.fitBounds(where.bounds, { ...FIT_OPTIONS, offset });
  else map.flyTo({ center: where.center, zoom: Math.max(map.getZoom(), POINT_ZOOM), offset });

  // Same as clicking it, once it's on screen: the point narrows the VPU
  // search for the forcing fetch.
  map.once("moveend", () => {
    if (seq !== searchSeq || !hasForcingSource()) return;
    const center = where.bounds ? where.bounds.getCenter() : where.center;
    openForcingPlot(num, map.project(center));
  });
  return true;
}

// The gage with USGS site number `site` in loaded gage tiles, or null.
function loadedGage(site) {
  if (!map.getSource(GAGE_FEATURE.source)) return null;
  const hits = map.querySourceFeatures(GAGE_FEATURE.source, {
    sourceLayer: GAGE_FEATURE.sourceLayer,
    filter: ["==", ["get", "hl_uri"], GAGE_URI_PREFIX + site],
  });
  return hits[0] ?? null;
}

// Find USGS gage `site`, fly to it and ring it. Resolves false if USGS has
// no location for it. Once the map settles there, the ring snaps to the
// hydrofabric's gage point (if it has one) and, when that gage's reach is in
// the loaded run, its panel and hydrograph open as if it had been clicked.
export async function searchGage(site, onStatus = () => {}) {
  const seq = ++searchSeq;
  let feature = loadedGage(site);
  let lonLat = feature?.geometry.coordinates;
  if (!lonLat) {
    onStatus("Looking up the gage…");
    const meta = await fetchGageMeta(site).catch(() => null);
    if (seq !== searchSeq) return true;
    lonLat = meta?.lonLat;
    if (!lonLat) return false;
  }

  clearMarks();
  setSearchPoint(lonLat);
  map.flyTo({
    center: lonLat,
    zoom: Math.max(map.getZoom(), GAGE_ZOOM),
    offset: sidebarFitOffset(),
  });

  // After moveend the tiles around the gage may still be loading; idle is
  // when they're in. (A running sim never idles; the ring just stays put.)
  map.once("moveend", () => {
    if (seq !== searchSeq) return;
    map.once("idle", () => {
      if (seq !== searchSeq) return;
      feature ??= loadedGage(site);
      if (!feature) return;
      setSearchPoint(feature.geometry.coordinates);
      if (state.data?.index.has(feature.properties.id)) showGageInfo(feature);
    });
  });
  return true;
}

// ---- Map control: a magnifier button that pops the search box out --------

export class SearchControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group map-search";

    this._button = iconButton(
      "maplibregl-ctrl-search",
      "Search catchments and gages",
      "M10.5,4a6.5,6.5,0,1,0,0,13a6.5,6.5,0,1,0,0-13ZM15.2,15.2L20,20",
    );
    this._button.setAttribute("aria-expanded", "false");
    this._button.onclick = () => this._setOpen(!this._open);

    this._panel = document.createElement("div");
    this._panel.className = "map-search-panel";
    const form = document.createElement("form");
    this._input = document.createElement("input");
    this._input.type = "search";
    this._input.placeholder = "cat-123 or USGS site no.";
    this._input.setAttribute("aria-label", "Find a catchment or USGS gage");
    this._input.spellcheck = false;
    this._status = document.createElement("div");
    this._status.className = "map-search-status";
    this._status.style.display = "none";
    form.append(this._input);
    this._panel.append(form, this._status);
    this._container.append(this._button, this._panel);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._search();
    });
    // The search input's clear button empties it: drop the outline / ring.
    this._input.addEventListener("input", () => {
      if (!this._input.value) {
        clearSearch();
        this._setStatus("");
      }
    });
    // Escape folds the box away (the result stays on the map).
    this._input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this._setOpen(false);
      this._button.focus();
    });
    // A click elsewhere folds an empty box away; one holding a query stays
    // so its status (or a retry) is still at hand.
    this._onOutside = (e) => {
      if (this._open && !this._input.value && !this._container.contains(e.target)) {
        this._setOpen(false);
      }
    };
    document.addEventListener("pointerdown", this._onOutside);

    this._open = false;
    return this._container;
  }

  onRemove() {
    document.removeEventListener("pointerdown", this._onOutside);
    this._container.remove();
  }

  _setOpen(open) {
    this._open = open;
    this._container.classList.toggle("open", open);
    this._button.classList.toggle("active", open);
    this._button.setAttribute("aria-expanded", String(open));
    if (open) this._input.focus();
  }

  async _search() {
    const text = this._input.value;
    if (!text.trim()) return;
    const query = parseSearch(text);
    if (!query) {
      this._setStatus("Enter cat-123 or a USGS site number", true);
      return;
    }
    const label = query.site ? `USGS-${query.site}` : `cat-${query.catchment}`;
    const onStatus = (s) => this._setStatus(s);
    this._input.disabled = true;
    try {
      const found = query.site
        ? await searchGage(query.site, onStatus)
        : await searchCatchment(query.catchment, onStatus);
      const missing = query.site ? `${label} wasn't found at USGS` : `${label} isn't in the hydrofabric`;
      this._setStatus(found ? "" : missing, !found);
    } catch (err) {
      console.error("Map search error:", err);
      this._setStatus(`Search failed: ${err.message}`, true);
    } finally {
      this._input.disabled = false;
      this._input.focus();
    }
  }

  _setStatus(text, isError = false) {
    this._status.textContent = text;
    this._status.classList.toggle("error", isError);
    this._status.style.display = text ? "block" : "none";
  }
}
