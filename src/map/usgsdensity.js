// ====================================================================
// The USGS Gages panel's density heatmap: the shown catalog sites
// (map/usgssites.js) as a MapLibre heatmap whose colours are a real density,
// sites per 1000 km², at any zoom and latitude.
//
// MapLibre's kernel at r px from a point is
//   weight * intensity * GAUSS_COEF * exp(-4.5 r² / R²)
// (R = heatmap-radius), summed into `heatmap-density`. Over a uniform density
// D that sums to weight * intensity * GAUSS_COEF * D * π R² / 4.5, which gives
// the intensity for density 1 = the chosen full scale.
//
// For that to hold everywhere:
// - R is fixed on the ground, doubling per zoom, down to MIN_RADIUS_PX. Under
//   that the ¼-resolution kernel buffer aliases, so R stays put on screen, and
//   as it grows on the ground the intensity falls to match.
// - R is in Mercator pixels, whose ground size shrinks with cos(latitude). R is
//   set for REF_LAT, and each point's weight undoes the difference in area.
// ====================================================================
import { map } from "../state.js";
import { USGS_DENSITY_SOURCE, USGS_DENSITY_LAYER } from "../config.js";
import { colormapColors } from "../color/colormaps.js";
import { getCatalog, onCatalogChange } from "../data/usgscatalog.js";
import { filteredMasks, siteFilter, onSiteFilterChange } from "./usgssites.js";
import { initialLayer, noteLayer } from "./layerprefs.js";

const SETTINGS_KEY = "usgs-density-settings";
const GAUSS_COEF = 0.3989422804014327; // MapLibre's heatmap shader
const KERNEL_FALLOFF = 4.5; // 0.5 * 3², likewise
const METRES_PER_PX_Z0 = 40075016.686 / 512; // at the equator
const REF_LAT = 39; // about the middle of CONUS
const REF_COS = Math.cos((REF_LAT * Math.PI) / 180);
const MIN_RADIUS_PX = 16;
const TOP_ZOOM = 12; // the layer's maxzoom
// A site's kernel is wider than the view well before this: fade to the dots.
const FADE_ZOOM = 10;
const OPACITY = 0.75;

const colors = colormapColors("icefire");
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");

// Low → high, fading in from nothing so empty country keeps its basemap.
export const DENSITY_RAMP = [`rgba(${rgb(colors[0])}, 0)`, ...colors.slice(1)];

const settings = loadSettings();
let visible = initialLayer("density");

function loadSettings() {
  const defaults = { radiusKm: 25, maxPer1000: 10 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

export function densitySettings() {
  return { ...settings };
}

// The density one site on its own reaches at its centre, in sites per
// 1000 km², to two figures: what the colours should be read against, since a
// small radius makes even a lone site look dense.
export function loneSitePeak(radiusKm) {
  return Number(((1000 * KERNEL_FALLOFF) / (Math.PI * radiusKm ** 2)).toPrecision(2));
}

// Any subset of { radiusKm, maxPer1000 }.
export function setDensity(patch) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: it still applies for this session.
  }
  applyPaint();
}

// Doesn't save: only a click on the checkbox does (map/layerprefs.js).
export function setDensityVisible(on) {
  visible = on;
  noteLayer("density", on);
  apply();
}

// ---- Paint ----------------------------------------------------------------

function applyPaint() {
  if (!map?.getLayer(USGS_DENSITY_LAYER)) return;
  const { radiusKm, maxPer1000 } = settings;
  // Where R on the ground reaches MIN_RADIUS_PX; below it R holds on screen.
  const radiusPxZ0 = (radiusKm * 1000) / (METRES_PER_PX_Z0 * REF_COS);
  const holdZoom = Math.log2(MIN_RADIUS_PX / radiusPxZ0);
  const intensity = KERNEL_FALLOFF / (GAUSS_COEF * Math.PI * radiusKm ** 2 * (maxPer1000 / 1000));

  map.setPaintProperty(USGS_DENSITY_LAYER, "heatmap-weight", ["get", "w"]);
  map.setPaintProperty(USGS_DENSITY_LAYER, "heatmap-radius", [
    "interpolate", ["exponential", 2], ["zoom"],
    holdZoom, MIN_RADIUS_PX,
    TOP_ZOOM, MIN_RADIUS_PX * 2 ** (TOP_ZOOM - holdZoom),
  ]);
  // Ground radius halves per zoom in until holdZoom, so its area quarters.
  map.setPaintProperty(USGS_DENSITY_LAYER, "heatmap-intensity", [
    "interpolate", ["exponential", 4], ["zoom"],
    0, intensity * 4 ** -holdZoom,
    holdZoom, intensity,
  ]);
  map.setPaintProperty(USGS_DENSITY_LAYER, "heatmap-color", [
    "interpolate", ["linear"], ["heatmap-density"],
    ...DENSITY_RAMP.flatMap((color, i) => [i / (DENSITY_RAMP.length - 1), color]),
  ]);
  map.setPaintProperty(USGS_DENSITY_LAYER, "heatmap-opacity", [
    "interpolate", ["linear"], ["zoom"],
    FADE_ZOOM, OPACITY,
    TOP_ZOOM, 0,
  ]);
}

// ---- Data -----------------------------------------------------------------

function toGeoJSON(catalog, masks) {
  const features = [];
  catalog.sites.forEach((site, i) => {
    if (!masks[i]) return;
    const areaScale = (REF_COS / Math.cos((site.lat * Math.PI) / 180)) ** 2;
    features.push({
      type: "Feature",
      properties: { f: masks[i], w: areaScale },
      geometry: { type: "Point", coordinates: [site.lon, site.lat] },
    });
  });
  return { type: "FeatureCollection", features };
}

// The source and filter only follow the panel while the layer is on.
let installedFor = null;
function apply() {
  if (!map?.getLayer(USGS_DENSITY_LAYER)) return;
  map.setLayoutProperty(USGS_DENSITY_LAYER, "visibility", visible ? "visible" : "none");
  if (!visible) return;
  map.setFilter(USGS_DENSITY_LAYER, siteFilter());
  const masks = filteredMasks();
  if (!masks || masks === installedFor) return;
  installedFor = masks;
  map.getSource(USGS_DENSITY_SOURCE).setData(toGeoJSON(getCatalog(), masks));
}

// Called once from map/init.js, before the style has loaded.
export function setupUsgsDensity() {
  onSiteFilterChange(apply);
  onCatalogChange(apply);
  map.once("load", () => {
    applyPaint();
    apply();
  });
}
