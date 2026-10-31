// ====================================================================
// Terrain brushes (the erosion panel): raise or lower the ground under a
// disc, or rain flow particles into it, while the left button (or one
// finger) is held. erosionState.tool picks which; "none" gives drags back
// to the map.
//
// Raise and lower add a smooth bump (erosionState.strength metres a second
// at the centre, 0 at the rim) to the terrain edits (flow/terrain.js) at
// the flow field's zoom, or a coarser one for a brush too big for it. The
// map's tiles refresh as it goes; the field is rerouted when the stroke
// ends. Rain sets erosionState.rain, which the particles spawn into.
// ====================================================================
import { map, flowState, erosionState } from "../state.js";
import { addTerrainDelta } from "./terrain.js";
import { demSource, fieldZoom, rebuildFlowField } from "./field.js";
// maplibregl is a global provided by the CDN <script> in index.html.

const SOURCE = "flow-brush";
const COLORS = { raise: "#d9a441", lower: "#4f8cff", rain: "#00d4ff" };
const EMPTY = { type: "FeatureCollection", features: [] };
const OUTLINE_POINTS = 48;
// Largest brush radius in DEM pixels; a bigger one edits a zoom up.
const MAX_RADIUS_PX = 192;
// Longest frame a stroke counts, s (a stall isn't a huge dab).
const MAX_FRAME_S = 0.1;

let cursor = null; // pointer, map-relative
let painting = false;
let pointerId = null;
let raf = null;
let lastT = 0;
let edited = false; // this stroke changed the terrain
const touches = new Set();

// The brush disc under `point`: { x, y, r } in Mercator, or null off the
// ground. Its diameter is erosionState.size css px across the screen there.
function footprint(point) {
  const ll = map.unproject(point);
  if (!ll || Math.abs(ll.lat) > 85) return null;
  const c = maplibregl.MercatorCoordinate.fromLngLat(ll);
  const e = maplibregl.MercatorCoordinate.fromLngLat(map.unproject([point.x + erosionState.size / 2, point.y]));
  const r = Math.hypot(e.x - c.x, e.y - c.y);
  return Number.isFinite(r) && r > 0 ? { x: c.x, y: c.y, r } : null;
}

function show() {
  const tool = erosionState.tool;
  const fp = cursor && tool !== "none" && erosionState.active ? footprint(cursor) : null;
  if (!fp) {
    map.getSource(SOURCE)?.setData(EMPTY);
    return;
  }
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, { type: "geojson", data: EMPTY });
    map.addLayer({ id: `${SOURCE}-fill`, type: "fill", source: SOURCE, paint: { "fill-opacity": 0.08 } });
    map.addLayer({ id: `${SOURCE}-line`, type: "line", source: SOURCE, paint: { "line-width": 2 } });
  }
  map.setPaintProperty(`${SOURCE}-fill`, "fill-color", COLORS[tool]);
  map.setPaintProperty(`${SOURCE}-fill`, "fill-opacity", painting ? 0.25 : 0.08);
  map.setPaintProperty(`${SOURCE}-line`, "line-color", COLORS[tool]);
  const rim = [];
  for (let k = 0; k <= OUTLINE_POINTS; k++) {
    const t = (2 * Math.PI * k) / OUTLINE_POINTS;
    const ll = new maplibregl.MercatorCoordinate(fp.x + fp.r * Math.cos(t), fp.y + fp.r * Math.sin(t)).toLngLat();
    rim.push([ll.lng, ll.lat]);
  }
  map.getSource(SOURCE).setData({ type: "Polygon", coordinates: [rim] });
}

// `seconds` of raising or lowering at `fp`.
function editAt(fp, seconds) {
  const dem = demSource();
  if (!dem) return;
  const T = dem.tileSize;
  let z = flowState.field?.z ?? fieldZoom(dem);
  while (z > 0 && fp.r * T * 2 ** z > MAX_RADIUS_PX) z--;
  const scale = T * 2 ** z;
  const cx = fp.x * scale, cy = fp.y * scale, rp = fp.r * scale;
  if (rp < 0.5) return;
  const x0 = Math.floor(cx - rp), y0 = Math.floor(cy - rp);
  const w = Math.ceil(cx + rp) - x0, h = Math.ceil(cy + rp) - y0;
  const grid = new Float32Array(w * h);
  const amt = (erosionState.tool === "raise" ? 1 : -1) * erosionState.strength * seconds;
  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      const d2 = ((x0 + X + 0.5 - cx) ** 2 + (y0 + Y + 0.5 - cy) ** 2) / (rp * rp);
      if (d2 < 1) grid[Y * w + X] = amt * (1 - d2) ** 2;
    }
  }
  if (addTerrainDelta(z, T, x0, y0, w, h, grid)) edited = true;
}

function paintFrame(t) {
  raf = requestAnimationFrame(paintFrame);
  const seconds = lastT ? Math.min(MAX_FRAME_S, (t - lastT) / 1000) : 1 / 60;
  lastT = t;
  const fp = cursor && footprint(cursor);
  if (erosionState.tool === "rain") erosionState.rain = fp;
  else if (fp) editAt(fp, seconds);
}

function stopPainting() {
  if (raf != null) cancelAnimationFrame(raf);
  raf = null;
  painting = false;
  pointerId = null;
  erosionState.rain = null;
  if (edited) {
    edited = false;
    rebuildFlowField();
  }
}

// Pick a tool ("none" | "raise" | "lower" | "rain"). Any tool takes
// left-drags and one-finger drags from the map; wheel and pinch zoom and
// right-drag rotate still work.
export function setBrushTool(tool) {
  stopPainting();
  erosionState.tool = tool;
  const on = tool !== "none";
  if (on) {
    map.dragPan.disable();
    map.doubleClickZoom.disable();
  } else {
    map.dragPan.enable();
    map.doubleClickZoom.enable();
  }
  map.getContainer().classList.toggle("flow-brush-on", on);
  show();
}

export function setupFlowBrush() {
  const container = map.getCanvasContainer();
  const pointOf = (e) => {
    const r = container.getBoundingClientRect();
    return new maplibregl.Point(e.clientX - r.left, e.clientY - r.top);
  };
  const active = () => erosionState.active && erosionState.tool !== "none";
  container.addEventListener("pointermove", (e) => {
    if (painting && e.pointerId !== pointerId) return;
    cursor = pointOf(e);
    if (active()) show();
  });
  container.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") {
      touches.add(e.pointerId);
      // A second finger: a pinch, not a stroke.
      if (touches.size > 1) {
        stopPainting();
        show();
        return;
      }
    }
    cursor = pointOf(e);
    if (!active() || e.button !== 0) return;
    painting = true;
    pointerId = e.pointerId;
    lastT = 0;
    show();
    raf = requestAnimationFrame(paintFrame);
  });
  const release = (e) => {
    touches.delete(e.pointerId);
    if (painting && e.pointerId === pointerId) stopPainting();
    show();
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  container.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    cursor = null;
    stopPainting();
    show();
  });
  // The camera moving under a still cursor moves the disc.
  map.on("move", () => active() && show());
}
