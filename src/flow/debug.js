// ====================================================================
// Flow debug overlays (flowState.debug), drawn as plain MapLibre layers on
// top of the style:
//   "rgb"  the DEM source's tiles as raw RGB images, from the same URLs the
//          flow worker fetches (so what it decodes, before decoding). Past
//          the data's real zoom the tiles 404 and nothing is drawn: those
//          are the areas the worker fills from coarser ancestors.
//   "dir"  the routed field's direction grid, one pixel per field cell:
//          hue is the downhill direction (red east, lime north, cyan west,
//          violet south), brightness the upstream area (log), outlets clear.
//          Redrawn whenever a field lands (flow/field.js).
// ====================================================================
import { map, flowState } from "../state.js";
import { demSource, onFlowField } from "./field.js";
// maplibregl is a global provided by the CDN <script> in index.html.

const RGB_SOURCE = "flow-debug-rgb";
const DIR_SOURCE = "flow-debug-dir";
// Blob URLs are revoked this long after being replaced, once MapLibre has
// surely loaded (or given up on) them.
const REVOKE_MS = 10000;

let dirUrl = null;
let canvas = null;

const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

function removeLayer(id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

function showRgb() {
  if (map.getSource(RGB_SOURCE)) return;
  const dem = demSource();
  if (!dem) {
    // The DEM's TileJSON hasn't loaded yet.
    map.once("idle", () => flowState.debug === "rgb" && flowState.active && showRgb());
    return;
  }
  map.addSource(RGB_SOURCE, {
    type: "raster",
    tiles: [dem.url],
    tileSize: dem.tileSize,
    maxzoom: dem.maxzoom,
  });
  map.addLayer({
    id: RGB_SOURCE,
    type: "raster",
    source: RGB_SOURCE,
    paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 },
  });
}

// HSV (s = 1) to RGB bytes.
function hue(h, v, out, o) {
  const k = (n) => {
    const t = (n + h * 6) % 6;
    return v * (1 - Math.max(0, Math.min(t, 4 - t, 1)));
  };
  out[o] = 255 * k(5);
  out[o + 1] = 255 * k(3);
  out[o + 2] = 255 * k(1);
  out[o + 3] = 255;
}

function showDir(f) {
  if (!f) return;
  const { w, h, dir, acc, outlet } = f;
  canvas ??= document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const px = img.data;
  let maxAcc = 2;
  for (let i = 0; i < w * h; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
  const logMax = Math.log(maxAcc);
  for (let i = 0; i < w * h; i++) {
    if (outlet[i]) continue; // stays transparent
    // dir's y is down; flip it so north is 90°.
    const a = Math.atan2(-dir[2 * i + 1], dir[2 * i]) / (2 * Math.PI);
    hue(a < 0 ? a + 1 : a, 0.45 + (0.55 * Math.log(acc[i])) / logMax, px, 4 * i);
  }
  ctx.putImageData(img, 0, 0);

  const west = (f.x0 / f.scale) * 360 - 180;
  const east = ((f.x0 + w) / f.scale) * 360 - 180;
  const north = latOf(f.y0 / f.scale);
  const south = latOf((f.y0 + h) / f.scale);
  const coordinates = [[west, north], [east, north], [east, south], [west, south]];
  canvas.toBlob((blob) => {
    // Superseded or switched off while encoding.
    if (flowState.field !== f || flowState.debug !== "dir" || !flowState.active) return;
    const old = dirUrl;
    dirUrl = URL.createObjectURL(blob);
    if (old) setTimeout(() => URL.revokeObjectURL(old), REVOKE_MS);
    const src = map.getSource(DIR_SOURCE);
    if (src) {
      src.updateImage({ url: dirUrl, coordinates });
      return;
    }
    map.addSource(DIR_SOURCE, { type: "image", url: dirUrl, coordinates });
    map.addLayer({
      id: DIR_SOURCE,
      type: "raster",
      source: DIR_SOURCE,
      paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 },
    });
  });
}

// Show what flowState.debug asks for (and nothing else).
export function applyFlowDebug() {
  if (!map?.style) return; // before the style exists (and debug is off then)
  const mode = flowState.active ? flowState.debug : "off";
  if (mode !== "rgb") removeLayer(RGB_SOURCE);
  if (mode !== "dir") {
    removeLayer(DIR_SOURCE);
    if (dirUrl) URL.revokeObjectURL(dirUrl);
    dirUrl = null;
    canvas = null;
  }
  if (mode === "rgb") showRgb();
  if (mode === "dir" && !map.getSource(DIR_SOURCE)) showDir(flowState.field);
}

onFlowField((f) => {
  if (flowState.active && flowState.debug === "dir") showDir(f);
});
