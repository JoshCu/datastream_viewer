// ====================================================================
// Gage layer visibility: the run's gages (only those sitting on a reach in
// the loaded run) plus the always-on USGS catalog dots (map/usgssites.js),
// which share the show/hide and label toggles. Once the catalog has loaded,
// the run's gages also follow the USGS Gages panel: only sites it shows are
// drawn, in their catalog colour (a gage the catalog lacks drops out).
// ====================================================================
import { state, map } from "../state.js";
import {
  HIDDEN_FILTER,
  GAGE_URI_PREFIX,
  GAGE_LAYER,
  GAGE_ICON,
  GAGE_GLOW_LAYER,
  GAGE_LABEL_LAYER,
  GAGE_FEATURE,
  USGS_SITES_LAYER,
  USGS_SITES_LABEL_LAYER,
  NWM_FLOWLINE_FEATURE,
} from "../config.js";
import { iconButton } from "../ui/dom.js";
import { initialLayer, noteLayer, saveLayer } from "./layerprefs.js";
import { shownSiteGroups, onSiteFilterChange } from "./usgssites.js";
import { onCatalogChange } from "../data/usgscatalog.js";

// A gage's USGS site number: hl_uri is "gages-<site>".
const SITE_NO = ["slice", ["get", "hl_uri"], GAGE_URI_PREFIX.length];
const RUN_GAGE_FILL = "#ffffff"; // before the catalog loads
const HOVER_COLOR = "#00d4ff";

// An upward triangle as a signed distance field (MapLibre's SDF convention:
// alpha 0.75 at the edge, falling 1/8 per px outward), so icon-color can
// recolour it per site and icon-halo draws its ring. Drawn at 2x, so the
// halo width is in image px: 3 there is ~1.5 CSS px.
const ICON_PX = 48;
const SDF_RADIUS = 8;
function triangleSdf() {
  const c = ICON_PX / 2;
  const side = 32;
  const h = (side * Math.sqrt(3)) / 2;
  // Centroid on the image centre, so the icon's default centre anchor sits
  // on the gage point.
  const pts = [
    [c, c - (2 * h) / 3],
    [c + side / 2, c + h / 3],
    [c - side / 2, c + h / 3],
  ];
  const data = new Uint8ClampedArray(ICON_PX * ICON_PX * 4);
  for (let y = 0; y < ICON_PX; y++) {
    for (let x = 0; x < ICON_PX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let dist = Infinity;
      let inside = true;
      for (let i = 0; i < 3; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % 3];
        const ex = bx - ax;
        const ey = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
        dist = Math.min(dist, Math.hypot(px - ax - t * ex, py - ay - t * ey));
        // Clockwise on screen (y down): inside is right of every edge.
        if (ex * (py - ay) - ey * (px - ax) < 0) inside = false;
      }
      const signed = inside ? -dist : dist;
      data[(y * ICON_PX + x) * 4 + 3] = 255 * (0.75 - signed / SDF_RADIUS);
    }
  }
  return { width: ICON_PX, height: ICON_PX, data };
}

// The map's missing-image resolver, so it's added on first use with any style.
export function addGageIcon(id) {
  if (id !== GAGE_ICON || map.hasImage(GAGE_ICON)) return;
  map.addImage(GAGE_ICON, triangleSdf(), { sdf: true, pixelRatio: 2 });
}

// The dot layers always carry the reach filter; the label layer only gets it
// when labels are actually switched on. For a CONUS run that filter is a
// multi-megabyte id list, structured-cloned to every style worker, so building
// it for a layer nobody is looking at is pure waste.
const DOT_LAYERS = [GAGE_LAYER, GAGE_GLOW_LAYER];

// Last filter handed to the dot layers, replayed onto the label layer the
// first time labels are shown.
let currentFilter = HIDDEN_FILTER;
let labelFilterApplied = false;
// The panel's site groups the filter and colour were last built for.
let styledFor;

// User toggles from GageControl. Labels only draw while gages are shown.
// Both start from map/layerprefs.js; only a click saves.
let gagesVisible = initialLayer("gages");
let labelsVisible = initialLayer("labels");

function applyGageVisibility() {
  const vis = (on) => (on ? "visible" : "none");
  map.setLayoutProperty(GAGE_LAYER, "visibility", vis(gagesVisible));
  map.setLayoutProperty(GAGE_GLOW_LAYER, "visibility", vis(gagesVisible));
  map.setLayoutProperty(USGS_SITES_LAYER, "visibility", vis(gagesVisible));
  for (const layer of [GAGE_LABEL_LAYER, USGS_SITES_LABEL_LAYER]) {
    map.setLayoutProperty(layer, "visibility", vis(gagesVisible && labelsVisible));
  }
}

export function setGagesVisible(on) {
  gagesVisible = on;
  noteLayer("gages", on);
  if (map.getLayer(GAGE_LAYER)) applyGageVisibility();
}

export function setGageLabelsVisible(on) {
  labelsVisible = on;
  noteLayer("labels", on);
  if (!map.getLayer(GAGE_LAYER)) return;
  if (on && !labelFilterApplied) {
    map.setFilter(GAGE_LABEL_LAYER, currentFilter);
    labelFilterApplied = true;
  }
  applyGageVisibility();
}

// ---- An NWM run's gages ------------------------------------------------
// The gage tiles name hydrofabric reaches, so an NWM run finds its gages the
// other way round: a reach's USGS site is the NWM tiles' `gages` attribute
// (z7+, omitted when blank). Only loaded tiles can be read, so the site ->
// COMID table grows as tiles stream in, like a "Load viewport" run's reaches.
let nwmSites = new Map(); // site number -> COMID
let nwmSitesFor = null; // the dataset nwmSites was gathered for
let harvestTimer = null;

function harvestNwmGages() {
  const data = state.data;
  if (data?.reaches !== "nwm" || !map.getSource(NWM_FLOWLINE_FEATURE.source)) return false;
  if (nwmSitesFor !== data) {
    nwmSites = new Map();
    nwmSitesFor = data;
  }
  const before = nwmSites.size;
  for (const f of map.querySourceFeatures(NWM_FLOWLINE_FEATURE.source, {
    sourceLayer: NWM_FLOWLINE_FEATURE.sourceLayer,
    filter: ["has", "gages"],
  })) {
    const site = f.properties.gages;
    if (site && !nwmSites.has(String(site)) && data.index.has(f.id)) nwmSites.set(String(site), f.id);
  }
  return nwmSites.size !== before;
}

// Called for each NWM tile that loads while an NWM run is on; coalesced, as
// a pan delivers tiles in bursts and each pass reads every loaded tile.
export function scheduleNwmGageHarvest() {
  if (state.data?.reaches !== "nwm" || harvestTimer) return;
  harvestTimer = setTimeout(() => {
    harvestTimer = null;
    if (harvestNwmGages()) updateGageFilter();
  }, 300);
}

// The COMID an NWM run's gage sits on, or undefined.
export function nwmReachForSite(site) {
  return nwmSitesFor === state.data ? nwmSites.get(site) : undefined;
}

// The loaded run's reach id a gage dot sits on, or null.
export function runReachOfGage(feature) {
  if (!state.data) return null;
  if (state.data.reaches === "nwm") return nwmReachForSite(siteFromGageFeature(feature)) ?? null;
  if (state.data.reaches === "grid") return null;
  return feature.properties.id ?? null;
}

// Which of the gage tiles' points belong to the loaded run: by reach id for a
// hydrofabric run, by site number for an NWM one.
function runGageFilter() {
  // A grid's cell ids aren't reaches: it has no gages of its own.
  if (!state.data || state.data.reaches === "grid") return HIDDEN_FILTER;
  if (state.data.reaches === "nwm") {
    harvestNwmGages();
    // match needs at least one label.
    return nwmSites.size ? ["match", SITE_NO, [...nwmSites.keys()], true, false] : HIDDEN_FILTER;
  }
  // index keys are de-duplicated; match rejects repeated labels.
  return ["match", ["get", "id"], Array.from(state.data.index.keys()), true, false];
}

// Show the gages on a reach in the loaded dataset, or hide the layer
// entirely when nothing is loaded. `match` is used rather than
// `in` because MapLibre compiles its label list into a hash lookup, which
// keeps a CONUS-sized id list cheap to evaluate per feature.
export function updateGageFilter() {
  if (!map?.getLayer(GAGE_LAYER)) return;
  const groups = shownSiteGroups();
  styledFor = groups;
  const onRun = runGageFilter();
  if (!state.data || !groups) currentFilter = onRun;
  else if (!groups.length) currentFilter = HIDDEN_FILTER;
  else {
    const nos = groups.flatMap((g) => g.nos);
    currentFilter = ["all", onRun, ["match", SITE_NO, nos, true, false]];
  }
  map.setPaintProperty(GAGE_LAYER, "icon-color", [
    "case",
    ["boolean", ["feature-state", "hover"], false],
    HOVER_COLOR,
    groups?.length
      ? ["match", SITE_NO, ...groups.flatMap((g) => [g.nos, g.color]), RUN_GAGE_FILL]
      : RUN_GAGE_FILL,
  ]);
  for (const layer of DOT_LAYERS) map.setFilter(layer, currentFilter);
  if (labelsVisible) {
    map.setFilter(GAGE_LABEL_LAYER, currentFilter);
    labelFilterApplied = true;
  } else {
    labelFilterApplied = false;
  }
  // Catch up on any toggle clicked before the style finished loading.
  applyGageVisibility();
}

// Restyle when the panel's settings or the catalog change. The catalog
// reports status changes too, so only rebuild when the groups did.
function restyleIfChanged() {
  if (shownSiteGroups() !== styledFor) updateGageFilter();
}
onSiteFilterChange(restyleIfChanged);
onCatalogChange(restyleIfChanged);

// USGS site number of a gage sitting on `reachId`, or null. Only gage tiles
// already loaded can be searched, which is fine for a reach just clicked on
// screen: its gage (if any) is drawn in the same view.
// USGS site number from a gage feature's hl_uri ("gages-<site>").
export function siteFromGageFeature(feature) {
  return String(feature.properties?.hl_uri || "").replace(
    new RegExp(`^${GAGE_URI_PREFIX}`),
    "",
  );
}

export function gageSiteForReach(reachId) {
  if (!map.getSource(GAGE_FEATURE.source)) return null;
  const hits = map.querySourceFeatures(GAGE_FEATURE.source, {
    sourceLayer: GAGE_FEATURE.sourceLayer,
    filter: ["==", ["get", "id"], reachId],
  });
  return hits[0] ? siteFromGageFeature(hits[0]) || null : null;
}

// ---- Map control: show/hide gages, show/hide gage id labels -----------

export class GageControl {
  onAdd(map) {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";

    // Dot with a ring: a gage marker.
    this._gageBtn = iconButton(
      "maplibregl-ctrl-gage maplibregl-ctrl-gage-toggle",
      "Show gages",
      "M12,9a3,3,0,1,0,3,3A3,3,0,0,0,12,9ZM12,5a7,7,0,1,0,7,7A7,7,0,0,0,12,5Z",
    );
    // Dot beside a text line: a labelled gage.
    this._labelBtn = iconButton(
      "maplibregl-ctrl-gage maplibregl-ctrl-gage-labels",
      "Show gage id labels",
      "M7,12a2,2,0,1,0-2,2A2,2,0,0,0,7,12ZM11,9h9M11,12h9M11,15h6",
    );

    this._gageBtn.onclick = () => {
      setGagesVisible(!gagesVisible);
      saveLayer("gages", gagesVisible);
      this._sync();
    };
    this._labelBtn.onclick = () => {
      setGageLabelsVisible(!labelsVisible);
      saveLayer("labels", labelsVisible);
      this._sync();
    };

    this._container.append(this._gageBtn, this._labelBtn);
    this._sync();
    // Apply the starting state (map/layerprefs.js) once the layers exist.
    map.once("load", () => {
      setGagesVisible(gagesVisible);
      setGageLabelsVisible(labelsVisible);
    });
    return this._container;
  }

  _sync() {
    this._gageBtn.classList.toggle("active", gagesVisible);
    this._gageBtn.title = gagesVisible ? "Hide gages" : "Show gages";
    this._labelBtn.classList.toggle("active", gagesVisible && labelsVisible);
    this._labelBtn.disabled = !gagesVisible;
    this._labelBtn.title = labelsVisible
      ? "Hide gage id labels"
      : "Show gage id labels";
  }

  onRemove() {
    this._container.remove();
  }
}
