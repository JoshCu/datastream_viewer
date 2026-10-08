// ====================================================================
// Map search, behind the magnifier button. As you type, a dropdown offers:
//   - river groups from the USGS catalog (data/usgscatalog.js): "tom bigbee"
//     -> Tombigbee River, its gages listed under it; Enter frames them all
//   - USGS sites by fuzzy name or by site-number prefix
//   - the catchment, for cat-N / wb-N / a short bare number
// A catchment flies there, is outlined, and opens its forcings when a
// forcing source is set; a gage is ringed, and opens its panel.
//
// A catchment in a divides tile that's already loaded is framed from its
// geometry straight away. Anything else is looked up in the hydrofabric
// index (data/workers/hfindex.js): its id column is scanned once per session
// (~10 MB of range reads) into a sorted table kept here, then each search
// reads just that catchment's coordinates.
//
// A gage is placed from loaded gage tiles, else the catalog, else the USGS
// station metadata (data/usgs.js) — so a site number the catalog lacks (no
// continuous record) is still found.
// ====================================================================
import { state, map } from "../state.js";
import {
  DIVIDE_FEATURE,
  GAGE_FEATURE,
  GAGE_URI_PREFIX,
  HIDDEN_FILTER,
  SEARCH_LAYER,
  SEARCH_POINT_SOURCE,
  USGS_OBS_TYPES,
} from "../config.js";
import { runTask } from "../data/loader.js";
import { fetchGageMeta } from "../data/usgs.js";
import { getCatalog, searchCatalog, siteTypes, loadUsgsCatalog } from "../data/usgscatalog.js";
import { hasForcingSource } from "../forcing/loader.js";
import { openForcingPlot } from "../ui/forcingplot.js";
import { showGageInfo, showSiteInfo } from "../ui/gagepanel.js";
import { iconButton } from "../ui/dom.js";
import { sidebarFitOffset } from "./paint.js";

// Close enough to see the catchment's outline when only its point is known.
const POINT_ZOOM = 11;
const GAGE_ZOOM = 12;
const FIT_OPTIONS = { padding: 80, maxZoom: 13 };
const GROUP_FIT_OPTIONS = { padding: 80, maxZoom: 12 };
const SUGGEST_DELAY_MS = 120;

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

function setSearchPoints(points) {
  map.getSource(SEARCH_POINT_SOURCE)?.setData({
    type: "FeatureCollection",
    features: points.map((coordinates) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates },
    })),
  });
}

function clearMarks() {
  if (map.getLayer(SEARCH_LAYER)) map.setFilter(SEARCH_LAYER, HIDDEN_FILTER);
  setSearchPoints([]);
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

// Find a gage by its monitoring-location id ("USGS-01013500"), fly to it and
// ring it. Resolves false if nothing knows where it is. The ring goes on the
// catalog dot when there is one (the hydrofabric's gage point can sit ~1 km
// off USGS's coordinates); otherwise on the hydrofabric's point, once its
// tile is in. Then its panel opens: with the hydrograph when that gage's
// reach is in the loaded run, else the catalog station panel.
export async function searchGage(id, onStatus = () => {}) {
  const seq = ++searchSeq;
  const site = id.replace(/^USGS-/, "");
  const usgs = id.startsWith("USGS-");
  const entry = getCatalog()?.byId.get(id);
  let feature = usgs ? loadedGage(site) : null;
  let lonLat = entry ? [entry.lon, entry.lat] : feature?.geometry.coordinates;
  if (!lonLat && usgs) {
    onStatus("Looking up the gage…");
    const meta = await fetchGageMeta(site).catch(() => null);
    if (seq !== searchSeq) return true;
    lonLat = meta?.lonLat;
  }
  if (!lonLat) return false;

  clearMarks();
  setSearchPoints([lonLat]);
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
      if (usgs) feature ??= loadedGage(site);
      if (feature && !entry) setSearchPoints([feature.geometry.coordinates]);
      if (feature && state.data?.index.has(feature.properties.id)) showGageInfo(feature);
      else if (entry) showSiteInfo(id);
    });
  });
  return true;
}

// Frame every gage of a river group and ring them all.
export function showGroup(group) {
  searchSeq++;
  clearMarks();
  const points = group.sites.map((s) => [s.lon, s.lat]);
  setSearchPoints(points);
  const bounds = new maplibregl.LngLatBounds();
  for (const p of points) bounds.extend(p);
  map.fitBounds(bounds, { ...GROUP_FIT_OPTIONS, offset: sidebarFitOffset() });
}

// ---- Suggestions ------------------------------------------------------------

// The dropdown's rows for a query, in display order. Each is
//   { kind: "group", group } | { kind: "site", site, member? }
//   | { kind: "catchment", num } | { kind: "lookup", id } | { kind: "note", text }
// The best river group comes first with its gages listed under it, so
// "tom bigbee" shows the whole river and Enter frames it.
function suggestionsFor(text) {
  const out = [];
  const parsed = parseSearch(text);
  const explicitCatchment = /^\s*(cat|wb)/i.test(text);
  if (parsed?.catchment != null) out.push({ kind: "catchment", num: parsed.catchment });
  if (explicitCatchment) return out;

  if (!getCatalog()) {
    if (parsed?.site) out.push({ kind: "lookup", id: `USGS-${parsed.site}` });
    out.push({ kind: "note", text: "USGS site list loading…" });
    return out;
  }
  const { groups, sites } = searchCatalog(text);
  const [top, ...otherGroups] = groups;
  const listed = new Set();
  if (top) {
    out.push({ kind: "group", group: top });
    for (const site of top.sites) {
      out.push({ kind: "site", site, member: true });
      listed.add(site);
    }
  }
  for (const group of otherGroups) out.push({ kind: "group", group });
  for (const site of sites) if (!listed.has(site)) out.push({ kind: "site", site });
  // A full site number the catalog doesn't have: it may still exist without
  // a continuous record, so offer the direct lookup.
  if (parsed?.site && !sites.some((s) => s.no === parsed.site)) {
    out.push({ kind: "lookup", id: `USGS-${parsed.site}` });
  }
  if (!out.length) out.push({ kind: "note", text: "No matches" });
  return out;
}

function dot(color) {
  const el = document.createElement("span");
  el.className = "map-search-dot";
  el.style.background = color;
  return el;
}

function optionRow(item) {
  const row = document.createElement("div");
  row.className = `map-search-option ${item.kind}`;
  row.setAttribute("role", "option");
  const main = document.createElement("span");
  main.className = "map-search-main";
  const sub = document.createElement("span");
  sub.className = "map-search-sub";

  if (item.kind === "group") {
    const { group } = item;
    main.textContent = group.label;
    sub.textContent = `${group.states ? `${group.states} · ` : ""}${group.sites.length} gages`;
    row.append(dot("transparent"), main, sub);
    row.querySelector(".map-search-dot").classList.add("river");
  } else if (item.kind === "site") {
    const { site } = item;
    const [first] = siteTypes(site, site.active);
    row.classList.toggle("member", !!item.member);
    row.classList.toggle("inactive", !site.active);
    main.textContent = site.name;
    sub.textContent = site.no;
    row.title = `${site.id}${site.active ? "" : " (not reporting)"}`;
    row.append(dot(first != null ? USGS_OBS_TYPES[first].color : "#888"), main, sub);
  } else if (item.kind === "catchment") {
    main.textContent = `Catchment cat-${item.num}`;
    row.append(main);
  } else if (item.kind === "lookup") {
    main.textContent = `Look up ${item.id}`;
    sub.textContent = "USGS";
    row.append(main, sub);
  } else {
    row.classList.add("disabled");
    main.textContent = item.text;
    row.append(main);
  }
  return row;
}

// ---- Map control: a magnifier button that pops the search box out --------

export class SearchControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group map-search";

    this._button = iconButton(
      "maplibregl-ctrl-search",
      "Search gages, rivers and catchments",
      "M10.5,4a6.5,6.5,0,1,0,0,13a6.5,6.5,0,1,0,0-13ZM15.2,15.2L20,20",
    );
    this._button.setAttribute("aria-expanded", "false");
    this._button.onclick = () => this._setOpen(!this._open);

    this._panel = document.createElement("div");
    this._panel.className = "map-search-panel";
    const form = document.createElement("form");
    this._input = document.createElement("input");
    this._input.type = "search";
    this._input.placeholder = "Gage, river, site no. or cat-123";
    this._input.setAttribute("aria-label", "Search gages, rivers and catchments");
    this._input.setAttribute("role", "combobox");
    this._input.setAttribute("aria-autocomplete", "list");
    this._input.spellcheck = false;
    this._input.autocomplete = "off";
    this._list = document.createElement("div");
    this._list.className = "map-search-list";
    this._list.setAttribute("role", "listbox");
    this._status = document.createElement("div");
    this._status.className = "map-search-status";
    this._status.style.display = "none";
    form.append(this._input);
    this._panel.append(form, this._list, this._status);
    this._container.append(this._button, this._panel);

    this._items = [];
    this._active = -1;
    this._timer = null;

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._submit();
    });
    this._input.addEventListener("input", () => {
      this._setStatus("");
      if (!this._input.value) {
        // The search input's clear button empties it: drop the outline / rings.
        clearSearch();
        this._renderList([]);
        return;
      }
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._suggest(), SUGGEST_DELAY_MS);
    });
    // Clicking back into a filled box brings its suggestions back.
    this._input.addEventListener("click", () => {
      if (this._input.value && !this._items.length) this._suggest();
    });
    this._input.addEventListener("keydown", (e) => this._onKey(e));
    // Rows act on mousedown, before the input's blur would matter.
    this._list.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".map-search-option");
      if (!row) return;
      e.preventDefault();
      const i = [...this._list.children].indexOf(row);
      if (i >= 0) this._choose(this._items[i]);
    });
    this._list.addEventListener("mousemove", (e) => {
      const row = e.target.closest(".map-search-option");
      const i = row ? [...this._list.children].indexOf(row) : -1;
      if (i >= 0 && i !== this._active) this._setActive(i, false);
    });
    // A click elsewhere folds an empty box away and closes the list; one
    // holding a query stays so its status (or a retry) is still at hand.
    this._onOutside = (e) => {
      if (!this._open || this._container.contains(e.target)) return;
      this._renderList([]);
      if (!this._input.value) this._setOpen(false);
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
    if (open) {
      this._input.focus();
      // In case the startup load failed or hasn't begun: searching wants it.
      if (!getCatalog()) loadUsgsCatalog();
    } else {
      this._renderList([]);
    }
  }

  _suggest() {
    const text = this._input.value;
    if (!text.trim()) return this._renderList([]);
    const items = suggestionsFor(text);
    this._renderList(items);
    if (!getCatalog()) {
      loadUsgsCatalog().then(() => {
        if (this._input.value === text && this._open) this._suggest();
      });
    }
  }

  _renderList(items) {
    this._items = items;
    this._list.replaceChildren(...items.map(optionRow));
    this._list.style.display = items.length ? "block" : "none";
    this._active = -1;
  }

  _setActive(i, scroll = true) {
    const rows = this._list.children;
    rows[this._active]?.classList.remove("active");
    this._active = i;
    const row = rows[i];
    if (!row) return;
    row.classList.add("active");
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }

  _onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this._items.length) this._renderList([]);
      else {
        this._setOpen(false);
        this._button.focus();
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!this._items.length) return this._suggest();
    const step = e.key === "ArrowDown" ? 1 : -1;
    let i = this._active;
    // Skip rows that do nothing (notes).
    for (let n = 0; n < this._items.length; n++) {
      i = (i + step + this._items.length) % this._items.length;
      if (this._items[i].kind !== "note") break;
    }
    this._setActive(i);
  }

  // Enter: the highlighted row, else the first one that does something.
  _submit() {
    const text = this._input.value;
    if (!text.trim()) return;
    clearTimeout(this._timer);
    const items = this._items.length ? this._items : suggestionsFor(text);
    const item = items[this._active] ?? items.find((x) => x.kind !== "note");
    if (item) this._choose(item);
    else this._setStatus(items[0]?.text ?? "No matches", true);
  }

  async _choose(item) {
    if (item.kind === "note") return;
    this._renderList([]);
    if (item.kind === "group") {
      this._input.value = item.group.label;
      showGroup(item.group);
      this._setStatus(`${item.group.sites.length} gages on the ${item.group.label}`);
      return;
    }
    if (item.kind === "site") this._input.value = item.site.name;
    const onStatus = (s) => this._setStatus(s);
    const label = item.kind === "catchment" ? `cat-${item.num}` : (item.site?.id ?? item.id);
    this._input.disabled = true;
    try {
      const found =
        item.kind === "catchment"
          ? await searchCatchment(item.num, onStatus)
          : await searchGage(item.site?.id ?? item.id, onStatus);
      const missing =
        item.kind === "catchment" ? `${label} isn't in the hydrofabric` : `${label} wasn't found at USGS`;
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
