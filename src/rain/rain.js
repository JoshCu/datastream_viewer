// ====================================================================
// Rainfall on the map. A load (data/rain.js) stays on the main thread as
// frames of float cells, and is drawn one of two ways:
//
//   - "cells": an image on a canvas source. The grid is regular in latitude
//     and the source's corners are interpolated in Mercator, so canvas rows
//     look up the grid row at their own latitude.
//   - "catchments": each divide's mean of the cells whose centres fall in it,
//     painted through feature-state like forcings (key `rain`, so it doesn't
//     collide with theirs on the same source). Rebuilt as divide tiles land.
//
// It has its own clock. setRainTimeIndex() is the only way to seek it.
// ====================================================================
import { map, rainState } from "../state.js";
import {
  DIVIDE_FEATURE,
  FORCING_LAYER,
  NO_DATA_COLOR,
  RAIN_CATCHMENT_LAYER,
  RAIN_FILL_OPACITY,
  RAIN_LAYER,
  RAIN_PRODUCTS,
  RAIN_SOURCE,
} from "../config.js";
import { colormapColors } from "../color/colormaps.js";
import { setMapCredit } from "../map/credits.js";
import { createStatePainter } from "../map/statepainter.js";

const listeners = new Set();

// fn({ kind }): "grid" (a load landed or was cleared), "time" (the clock moved).
export function onRainChange(fn) {
  listeners.add(fn);
}
const emit = (kind) => listeners.forEach((fn) => fn({ kind }));

const fillOpacity = () => (rainState.visible ? RAIN_FILL_OPACITY : 0);

// ---- Colour --------------------------------------------------------------

function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 256 little-endian RGBA pixels along a colour map's stops.
let lutFor = null;
let lutCache = null;
function colorLut(id) {
  if (lutFor !== id) {
    lutFor = id;
    lutCache = buildLut(colormapColors(id));
  }
  return lutCache;
}

function buildLut(colors) {
  const stops = colors.map(parseHex);
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(p));
    const f = p - k;
    const [r, g, b] = stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * f));
    lut[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return lut;
}

// value -> 0..1 between the variable's min and max; below min is "nothing".
function ramp(info) {
  if (info.log) {
    const lo = Math.log(info.min);
    const k = 1 / (Math.log(info.max) - lo);
    return (v) => (Math.log(v) - lo) * k;
  }
  const k = 1 / (info.max - info.min);
  return (v) => (v - info.min) * k;
}

// ---- Cells: the image ----------------------------------------------------

let canvas = null;
let image = null;
let rowLut = null; // canvas row -> grid row
let corners = null;

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const mercLat = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

function prepareImage(grid) {
  canvas ??= document.createElement("canvas");
  canvas.width = grid.nx;
  canvas.height = grid.ny;
  image = canvas.getContext("2d").createImageData(grid.nx, grid.ny);

  const halfLat = Math.abs(grid.dLat) / 2;
  const halfLon = Math.abs(grid.dLon) / 2;
  const lastLat = grid.lat0 + (grid.ny - 1) * grid.dLat;
  const lastLon = grid.lon0 + (grid.nx - 1) * grid.dLon;
  const north = Math.max(grid.lat0, lastLat) + halfLat;
  const south = Math.min(grid.lat0, lastLat) - halfLat;
  const west = Math.min(grid.lon0, lastLon) - halfLon;
  const east = Math.max(grid.lon0, lastLon) + halfLon;
  corners = [[west, north], [east, north], [east, south], [west, south]];

  const top = mercY(Math.min(north, 85));
  const bottom = mercY(Math.max(south, -85));
  rowLut = new Int32Array(grid.ny);
  for (let r = 0; r < grid.ny; r++) {
    const lat = mercLat(top + ((r + 0.5) / grid.ny) * (bottom - top));
    rowLut[r] = Math.max(0, Math.min(grid.ny - 1, Math.round((lat - grid.lat0) / grid.dLat)));
  }
}

function ensureCellLayer() {
  const src = map.getSource(RAIN_SOURCE);
  if (src) src.setCoordinates(corners);
  else map.addSource(RAIN_SOURCE, { type: "canvas", canvas, coordinates: corners, animate: false });
  if (!map.getLayer(RAIN_LAYER)) {
    map.addLayer(
      {
        id: RAIN_LAYER,
        type: "raster",
        source: RAIN_SOURCE,
        paint: {
          "raster-fade-duration": 0,
          "raster-resampling": "nearest",
          "raster-opacity": fillOpacity(),
        },
      },
      map.getLayer(FORCING_LAYER) ? FORCING_LAYER : undefined,
    );
  }
  return map.getSource(RAIN_SOURCE);
}

function paintCells() {
  const grid = rainState.grid;
  const { nx, ny, frames, info } = grid;
  const lut = colorLut(rainState.colormap);
  const toT = ramp(info);
  const { min } = info;
  const px = new Uint32Array(image.data.buffer);
  const frame = rainState.timeIndex * ny * nx;
  let k = 0;
  for (let r = 0; r < ny; r++) {
    const row = frame + rowLut[r] * nx;
    for (let c = 0; c < nx; c++, k++) {
      const v = frames[row + c];
      // NaN fails this too.
      if (v >= min) {
        const t = toT(v);
        px[k] = lut[t >= 1 ? 255 : (t * 255) | 0];
      } else {
        px[k] = 0;
      }
    }
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
  const src = ensureCellLayer();
  // A non-animated canvas source uploads its texture in prepare(), which
  // pause() runs once.
  src.play();
  src.pause();
  map.triggerRepaint();
}

function removeCellLayer() {
  if (map.getLayer(RAIN_LAYER)) map.removeLayer(RAIN_LAYER);
  if (map.getSource(RAIN_SOURCE)) map.removeSource(RAIN_SOURCE);
}

// ---- Catchments: means through feature-state -------------------------------

// { index: Map<cat id, row>, rows: Float32Array[] (nT values each), gen }
let table = { index: new Map(), rows: [], gen: 0 };
let tableTimer = null;

const painter = createStatePainter({
  layer: RAIN_CATCHMENT_LAYER,
  feature: DIVIDE_FEATURE,
  stateKey: "rain",
  lookup: () => {
    if (!rainState.grid || rainState.display !== "catchments") return null;
    const t = rainState.timeIndex;
    const { rows, index, gen } = table;
    return { index, key: `${gen}:${t}`, value: (row) => rows[row][t] };
  },
});

function colorExpression(info, colors) {
  const value = ["coalesce", ["feature-state", "rain"], -1];
  const stops = colors.flatMap((c, i) => {
    const f = i / (colors.length - 1);
    return [info.log ? Math.log(info.min) + f * (Math.log(info.max) - Math.log(info.min)) : info.min + f * (info.max - info.min), c];
  });
  // ln(0) isn't a number, so the test comes first.
  const x = info.log ? ["ln", ["max", value, info.min]] : value;
  return ["case", ["<", value, info.min], NO_DATA_COLOR, ["interpolate", ["linear"], x, ...stops]];
}

function ensureCatchmentLayer() {
  if (map.getLayer(RAIN_CATCHMENT_LAYER)) return;
  map.addLayer(
    {
      id: RAIN_CATCHMENT_LAYER,
      type: "fill",
      source: DIVIDE_FEATURE.source,
      "source-layer": DIVIDE_FEATURE.sourceLayer,
      paint: {
        "fill-color": NO_DATA_COLOR,
        "fill-opacity": fillOpacity(),
        "fill-antialias": false,
      },
    },
    map.getLayer(FORCING_LAYER) ? FORCING_LAYER : undefined,
  );
}

function removeCatchmentLayer() {
  clearTimeout(tableTimer);
  painter.reset();
  // Only our key, since forcings may be painted on the same features. Removing
  // one key needs the id, so this goes through the ids it may have painted.
  const target = { ...DIVIDE_FEATURE, id: 0 };
  for (const id of table.index.keys()) {
    target.id = id;
    map.removeFeatureState(target, "rain");
  }
  table = { index: new Map(), rows: [], gen: table.gen + 1 };
  if (map.getLayer(RAIN_CATCHMENT_LAYER)) map.removeLayer(RAIN_CATCHMENT_LAYER);
}

// Add the cells whose centres fall in a polygon's rings (even-odd, so holes
// work) to `cells`, as row * nx + col.
function rasterize(rings, grid, cells) {
  let south = Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p[1] < south) south = p[1];
      if (p[1] > north) north = p[1];
    }
  }
  const a = (south - grid.lat0) / grid.dLat;
  const b = (north - grid.lat0) / grid.dLat;
  const r0 = Math.max(0, Math.ceil(Math.min(a, b)));
  const r1 = Math.min(grid.ny - 1, Math.floor(Math.max(a, b)));
  const crossings = [];
  for (let r = r0; r <= r1; r++) {
    const lat = grid.lat0 + r * grid.dLat;
    crossings.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j];
        const [x2, y2] = ring[i];
        if (y1 > lat !== y2 > lat) crossings.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const ca = (crossings[k] - grid.lon0) / grid.dLon;
      const cb = (crossings[k + 1] - grid.lon0) / grid.dLon;
      const c0 = Math.max(0, Math.ceil(Math.min(ca, cb)));
      const c1 = Math.min(grid.nx - 1, Math.floor(Math.max(ca, cb)));
      for (let c = c0; c <= c1; c++) cells.add(r * grid.nx + c);
    }
  }
}

// The cell at a point, as row * nx + col, or -1 off the grid.
function cellAt(grid, lng, lat) {
  const r = Math.round((lat - grid.lat0) / grid.dLat);
  const c = Math.round((lng - grid.lon0) / grid.dLon);
  return r < 0 || r >= grid.ny || c < 0 || c >= grid.nx ? -1 : r * grid.nx + c;
}

function featureCenter(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const poly of polys) {
    for (const p of poly[0]) {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > n) n = p[1];
    }
  }
  return [(w + e) / 2, (s + n) / 2];
}

// Every loaded divide's mean per frame. A divide comes in one piece per tile,
// so cells are gathered across its pieces first. One too small to hold a cell
// centre takes the cell at its middle.
function rebuildTable() {
  const grid = rainState.grid;
  if (!grid || rainState.display !== "catchments") return;
  const byId = new Map();
  for (const f of map.querySourceFeatures(DIVIDE_FEATURE.source, { sourceLayer: DIVIDE_FEATURE.sourceLayer })) {
    if (f.id == null) continue;
    let entry = byId.get(f.id);
    if (!entry) byId.set(f.id, (entry = { cells: new Set(), geometry: f.geometry }));
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) rasterize(rings, grid, entry.cells);
  }
  const { nT, ny, nx, frames } = grid;
  const frameSize = ny * nx;
  const index = new Map();
  const rows = [];
  for (const [id, { cells, geometry }] of byId) {
    if (!cells.size) {
      const at = cellAt(grid, ...featureCenter(geometry));
      if (at < 0) continue;
      cells.add(at);
    }
    const list = [...cells];
    const row = new Float32Array(nT);
    for (let t = 0; t < nT; t++) {
      const base = t * frameSize;
      let sum = 0;
      let count = 0;
      for (let k = 0; k < list.length; k++) {
        const v = frames[base + list[k]];
        if (v === v) {
          sum += v;
          count++;
        }
      }
      row[t] = count ? sum / count : -1;
    }
    index.set(id, rows.length);
    rows.push(row);
  }
  table = { index, rows, gen: table.gen + 1 };
  painter.markViewDirty();
  painter.schedule();
}

function scheduleTable() {
  clearTimeout(tableTimer);
  tableTimer = setTimeout(rebuildTable, 300);
}

// A divides tile landed (map/init.js): it may complete catchments.
export function rainDivideTileLoaded() {
  if (rainState.grid && rainState.display === "catchments") scheduleTable();
}

// The camera settled: the rendered catchments changed.
export function invalidateRainView() {
  if (rainState.grid && rainState.display === "catchments") {
    painter.markViewDirty();
    painter.schedule();
  }
}

// ---- The mode ---------------------------------------------------------------

function redraw() {
  const grid = rainState.grid;
  if (!grid) return;
  if (rainState.display === "catchments") painter.schedule();
  else paintCells();
}

// Rebuild for the current grid + display + colours.
function applyDisplay() {
  const grid = rainState.grid;
  if (rainState.display === "catchments" && grid) {
    removeCellLayer();
    ensureCatchmentLayer();
    map.setPaintProperty(RAIN_CATCHMENT_LAYER, "fill-color", colorExpression(grid.info, colormapColors(rainState.colormap)));
    rebuildTable();
  } else {
    removeCatchmentLayer();
    if (grid) paintCells();
    else removeCellLayer();
  }
}

export function showRainGrid(grid) {
  removeCatchmentLayer(); // the last load's values mustn't outlive it
  rainState.grid = grid;
  rainState.visible = true;
  rainState.timeIndex = 0;
  prepareImage(grid);
  applyDisplay();
  setMapCredit("rain", RAIN_PRODUCTS[grid.product].credit);
  emit("grid");
}

export function clearRain() {
  rainState.grid = null;
  rainState.visible = true;
  rainState.timeIndex = 0;
  applyDisplay();
  setMapCredit("rain", null);
  emit("grid");
}

// Show or hide the load without dropping it. By opacity, so the catchment
// layer stays queryable and its painter doesn't need waking on the way back.
export function setRainVisible(on) {
  rainState.visible = on;
  if (map.getLayer(RAIN_LAYER)) map.setPaintProperty(RAIN_LAYER, "raster-opacity", fillOpacity());
  if (map.getLayer(RAIN_CATCHMENT_LAYER)) map.setPaintProperty(RAIN_CATCHMENT_LAYER, "fill-opacity", fillOpacity());
  // The credit is on the map only while the layer is.
  setMapCredit("rain", on && rainState.grid ? RAIN_PRODUCTS[rainState.grid.product].credit : null);
}

export function setRainDisplay(display) {
  rainState.display = display;
  applyDisplay();
}

export function setRainColormap(id) {
  rainState.colormap = id;
  applyDisplay();
}

export function setRainTimeIndex(i) {
  const grid = rainState.grid;
  if (!grid) return;
  const clamped = Math.max(0, Math.min(grid.nT - 1, i));
  if (clamped === rainState.timeIndex) return;
  rainState.timeIndex = clamped;
  redraw();
  emit("time");
}

// Follow another clock: seek to the frame covering `ms`, if the load does.
export function followRainClock(ms) {
  const grid = rainState.grid;
  if (!grid || !Number.isFinite(ms)) return;
  const step = grid.nT > 1 ? grid.time[1] - grid.time[0] : 0;
  if (ms < grid.time[0] - step / 2 || ms > grid.time[grid.nT - 1] + step / 2) return;
  setRainTimeIndex(step ? Math.round((ms - grid.time[0]) / step) : 0);
}

// The value under a point at the current time; undefined off the grid.
export function rainValueAt(lng, lat) {
  const grid = rainState.grid;
  if (!grid) return undefined;
  const at = cellAt(grid, lng, lat);
  return at < 0 ? undefined : grid.frames[rainState.timeIndex * grid.ny * grid.nx + at];
}

// The cell under a point, for the hover tooltip: { key, value, lat, lng, ring
// (its outline) }, or null off the grid.
export function rainCellAt(lng, lat) {
  const grid = rainState.grid;
  if (!grid) return null;
  const key = cellAt(grid, lng, lat);
  if (key < 0) return null;
  const row = Math.floor(key / grid.nx);
  const col = key % grid.nx;
  const cy = grid.lat0 + row * grid.dLat;
  const cx = grid.lon0 + col * grid.dLon;
  const hy = Math.abs(grid.dLat) / 2;
  const hx = Math.abs(grid.dLon) / 2;
  return {
    key,
    value: grid.frames[rainState.timeIndex * grid.ny * grid.nx + key],
    lat: cy,
    lng: cx,
    ring: [[cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy], [cx - hx, cy - hy]],
  };
}

// A catchment's mean at the current time, while drawn by catchment: undefined
// if it isn't in the table, negative if none of its cells had data.
export function rainCatchmentValue(id) {
  const row = table.index.get(id);
  return row === undefined ? undefined : table.rows[row][rainState.timeIndex];
}

// A basemap switch drops the runtime source and layers.
export function restoreRainAfterStyle() {
  if (rainState.grid) applyDisplay();
}
