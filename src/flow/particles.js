// ====================================================================
// Flow particles: rain dropped evenly over the screen, running down the
// routed DEM (flow/field.js), drawn as fading trails with deck.gl.
//
// Like a wind map, but the vector field is surface-flow direction, so the
// particles gather into the drainage network and the rivers draw themselves.
// Speed is √(slope), times upstream area^FLOW_MANNING_EXP in Manning mode,
// normalised per field so its 90th percentile moves flowState.speed css px a
// frame whatever the zoom. Colour is upstream area (log) or speed.
//
// Positions are Mercator [0, 1] so they survive a field swap. A trail is
// drawn as the particle's last flowState.trail − 1 moves, and every move a
// frame makes (one segment per particle) is its own LineLayer: a ring of
// layers, oldest drawn first, each fading by its layer opacity as it ages.
// So a frame uploads only the newest layer's segments, not every trail
// (deck re-uploads an attribute only when its typed array changes identity,
// so the newest layer always takes the spare buffer set). With the field a
// degree or two across, positions are offsets from its centre
// (LNGLAT_OFFSETS), so float32 keeps sub-metre precision at high zoom.
// ====================================================================
import { map, flowState } from "../state.js";
import { FLOW_MANNING_EXP, FLOW_LIFE_FRAMES, FLOW_LIFT_M } from "../config.js";
import { colormapColors } from "../color/colormaps.js";
import { loadDeck, setDeckLayers } from "../map/deck.js";
import { onFlowField } from "./field.js";

const OWNER = "flow";
const LUT_SIZE = 256;
// Frames a particle takes to fade in after spawning, and out before dying.
const FADE_FRAMES = 12;
// Normalised speed range (1 = the field's 90th percentile).
const MIN_SPEED = 0.04;
const MAX_SPEED = 3;
// Largest move per sub-step, in field cells, so a fast particle doesn't
// jump a ridge or a channel.
const MAX_STEP_CELLS = 0.75;
const MAX_SUBSTEPS = 6;
// Spawn grid: the screen is unprojected at (n+1)² points after each move, and
// spawns pick a random grid quad, so rain is even on screen even when pitched.
const SPAWN_GRID = 16;
// Field spans (degrees of latitude) below which positions are offsets.
const OFFSET_SPAN_DEG = 2;
const SAMPLE_CELLS = 20000; // cells sampled for the speed normalisation

let deck = null;
let rafId = null;
let lastFrame = 0;
let needsAlloc = false; // the count changed: reallocate at the next frame

// Particles.
let P = 0;
let mx, my; // Float64Array(P): Mercator position
let age, life; // Int32Array(P)
let live; // Uint8Array(P): 0 = waiting to spawn
let last; // Float64Array(P*3): lng, lat, z where it was drawn last frame
let hasLast; // Uint8Array(P): `last` is this life's (so a segment can start there)

// The ring of trail layers: slots[k] = { buf, data, origin, offsets } or
// null, `head` the newest. Buffer sets are one more than the slots; the
// spare is what the next frame writes into.
let slots = [];
let head = 0;
let spare = null;
let lut = null;

// Field-derived.
let field = null;
let speed = null; // Float32Array(w*h): normalised speed per cell
let colour = null; // Uint8Array(w*h): LUT index per cell
let origin = [0, 0];
let offsets = false;
let spawnQuads = null; // Float64Array of quad corners, or null

function lutFor(id) {
  const stops = colormapColors(id).map((hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
  const out = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / (LUT_SIZE - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
    }
  }
  return out;
}

export function setFlowColormap() {
  lut = lutFor(flowState.colormap);
}

const newBuf = () => ({
  src: new Float32Array(P * 3),
  tgt: new Float32Array(P * 3),
  col: new Uint8Array(P * 4),
});

function allocate() {
  P = flowState.count;
  mx = new Float64Array(P);
  my = new Float64Array(P);
  age = new Int32Array(P);
  life = new Int32Array(P);
  live = new Uint8Array(P);
  last = new Float64Array(P * 3);
  hasLast = new Uint8Array(P);
  slots = new Array(Math.max(1, flowState.trail - 1)).fill(null);
  head = 0;
  spare = newBuf();
}

// Particle count changed: start everyone over, at the next frame (so a
// slider drag reallocates at most once a frame).
export function resetFlowParticles() {
  needsAlloc = true;
}

// Trail length changed: keep the particles, regrow the ring of layers.
export function resizeFlowTrail() {
  if (rafId == null) return;
  const n = Math.max(1, flowState.trail - 1);
  // Oldest first, so the newest stay when it shrinks.
  const kept = [];
  for (let a = slots.length - 1; a >= 0; a--) {
    const s = slots[(head - a + slots.length) % slots.length];
    if (s) kept.push(s);
  }
  slots = new Array(n).fill(null);
  const from = Math.max(0, kept.length - n);
  for (let i = from; i < kept.length; i++) slots[i - from] = kept[i];
  head = Math.max(0, Math.min(n, kept.length - from) - 1);
}

// ---- Field ----------------------------------------------------------

// Each cell's speed for the current model, scaled so the 90th percentile of
// the land cells (sampled) is 1, and clamped; and its colour index for the
// current colour-by. Rerun when either setting changes.
export function updateFlowCells() {
  if (!field) return;
  const { sqrtSlope, acc, outlet } = field;
  const n = field.w * field.h;
  const manning = flowState.speedModel === "manning";
  speed = new Float32Array(n);
  for (let i = 0; i < n; i++) speed[i] = manning ? sqrtSlope[i] * acc[i] ** FLOW_MANNING_EXP : sqrtSlope[i];
  const every = Math.max(1, Math.floor(n / SAMPLE_CELLS));
  const vals = [];
  for (let i = 0; i < n; i += every) if (!outlet[i]) vals.push(speed[i]);
  vals.sort((a, b) => a - b);
  const norm = (vals.length && vals[Math.floor(vals.length * 0.9)]) || 1;
  for (let i = 0; i < n; i++) speed[i] = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed[i] / norm));

  colour = new Uint8Array(n);
  const top = LUT_SIZE - 1;
  if (flowState.colorBy === "speed") {
    for (let i = 0; i < n; i++) colour[i] = Math.min(top, Math.round((speed[i] / 2) * top));
  } else {
    let maxAcc = 2;
    for (let i = 0; i < n; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
    const k = top / Math.log(maxAcc);
    for (let i = 0; i < n; i++) colour[i] = Math.round(Math.log(acc[i]) * k);
  }
}

function installField(f) {
  field = f;
  updateFlowCells();
  // Centre of the field, for offset positions.
  const cx = (f.x0 + f.w / 2) / f.scale;
  const cy = (f.y0 + f.h / 2) / f.scale;
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  const span = lat(f.y0 / f.scale) - lat((f.y0 + f.h) / f.scale);
  // Each layer keeps the origin it was written with, so this can move freely.
  offsets = span < OFFSET_SPAN_DEG;
  origin = offsets ? [cx * 360 - 180, lat(cy)] : [0, 0];
  rebuildSpawnGrid();
}

// ---- Spawning ---------------------------------------------------------

export function rebuildSpawnGrid() {
  const canvas = map.getCanvas();
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const n = SPAWN_GRID + 1;
  const pts = new Float64Array(n * n * 2).fill(NaN);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ll = map.unproject([(i / SPAWN_GRID) * W, (j / SPAWN_GRID) * H]);
      if (!ll || Math.abs(ll.lat) > 85) continue;
      const m = maplibregl.MercatorCoordinate.fromLngLat(ll);
      pts[(j * n + i) * 2] = m.x;
      pts[(j * n + i) * 2 + 1] = m.y;
    }
  }
  spawnQuads = pts;
}

// Field cell under Mercator (x, y), or -1 off the field.
function cellAt(x, y) {
  const gx = Math.floor(x * field.scale - field.x0);
  const gy = Math.floor(y * field.scale - field.y0);
  if (gx < 0 || gy < 0 || gx >= field.w || gy >= field.h) return -1;
  return gy * field.w + gx;
}

function spawn(p) {
  const n = SPAWN_GRID + 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    let x, y;
    const q = spawnQuads;
    if (q) {
      // A random point in a random screen quad (bilinear in its corners).
      const i = Math.floor(Math.random() * SPAWN_GRID);
      const j = Math.floor(Math.random() * SPAWN_GRID);
      const u = Math.random();
      const v = Math.random();
      const a = (j * n + i) * 2, b = a + 2, c = a + n * 2, d = c + 2;
      x = (q[a] * (1 - u) + q[b] * u) * (1 - v) + (q[c] * (1 - u) + q[d] * u) * v;
      y = (q[a + 1] * (1 - u) + q[b + 1] * u) * (1 - v) + (q[c + 1] * (1 - u) + q[d + 1] * u) * v;
      if (!Number.isFinite(x)) continue; // a corner above the horizon
    } else {
      x = (field.x0 + Math.random() * field.w) / field.scale;
      y = (field.y0 + Math.random() * field.h) / field.scale;
    }
    const cell = cellAt(x, y);
    if (cell < 0 || field.outlet[cell]) continue;
    mx[p] = x;
    my[p] = y;
    age[p] = 0;
    life[p] = FLOW_LIFE_FRAMES[0] + Math.floor(Math.random() * (FLOW_LIFE_FRAMES[1] - FLOW_LIFE_FRAMES[0]));
    live[p] = 1;
    hasLast[p] = 0;
    return;
  }
  live[p] = 0;
}

// ---- Stepping -----------------------------------------------------------

// The cell interpolation sampleAt last did, for finishAt.
let i00 = 0, w00 = 0, w10 = 0, w01 = 0, w11 = 0, near = 0;
let dirX = 0, dirY = 0, spd = 0;

// Bilinear direction and speed at Mercator (x, y) into dirX/dirY/spd. False
// off the field or over an outlet (the nearest cell decides: water that's
// reached the sea has left).
function sampleAt(x, y) {
  const f = field;
  const gx = x * f.scale - f.x0 - 0.5;
  const gy = y * f.scale - f.y0 - 0.5;
  if (!(gx >= 0 && gy >= 0 && gx <= f.w - 1 && gy <= f.h - 1)) return false;
  const ix = Math.min(f.w - 2, Math.floor(gx));
  const iy = Math.min(f.h - 2, Math.floor(gy));
  const tx = gx - ix;
  const ty = gy - iy;
  i00 = iy * f.w + ix;
  near = i00 + (tx < 0.5 ? 0 : 1) + (ty < 0.5 ? 0 : f.w);
  if (f.outlet[near]) return false;
  w00 = (1 - tx) * (1 - ty);
  w10 = tx * (1 - ty);
  w01 = (1 - tx) * ty;
  w11 = tx * ty;
  const d = f.dir;
  const a = 2 * i00, b = a + 2, c = a + 2 * f.w, e = c + 2;
  dirX = d[a] * w00 + d[b] * w10 + d[c] * w01 + d[e] * w11;
  dirY = d[a + 1] * w00 + d[b + 1] * w10 + d[c + 1] * w01 + d[e + 1] * w11;
  const j = i00 + f.w;
  spd = speed[i00] * w00 + speed[i00 + 1] * w10 + speed[j] * w01 + speed[j + 1] * w11;
  return true;
}

// Elevation (m) at the point sampleAt last succeeded at.
function elevAtSample() {
  const e = field.elev;
  const j = i00 + field.w;
  const v = e[i00] * w00 + e[i00 + 1] * w10 + e[j] * w01 + e[j + 1] * w11;
  return Number.isFinite(v) ? v : 0;
}

// Move every particle one frame and write its segment (where it was drawn
// last frame → where it is now) into `buf`.
function step(dtFrames, buf) {
  // css px per field cell at the map's current zoom.
  const pxPerCell = (512 * 2 ** map.getZoom()) / field.scale;
  const terrain = map.getTerrain();
  const exag = terrain ? terrain.exaggeration ?? 1 : 0;
  const lift = FLOW_LIFT_M * Math.max(1, exag);
  const [olng, olat] = origin;
  const { src, tgt, col } = buf;
  const move = (flowState.speed * dtFrames) / pxPerCell;
  for (let p = 0; p < P; p++) {
    const p3 = p * 3;
    const p4 = p * 4;
    col[p4 + 3] = 0;
    if (!live[p] || age[p] >= life[p]) spawn(p);
    if (!live[p]) continue;
    let alive = sampleAt(mx[p], my[p]);
    if (alive) {
      const cells = move * spd;
      const sub = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(cells / MAX_STEP_CELLS)));
      const ds = cells / sub / field.scale;
      for (let k = 0; k < sub && alive; k++) {
        mx[p] += dirX * ds;
        my[p] += dirY * ds;
        alive = sampleAt(mx[p], my[p]);
      }
    }
    if (!alive) {
      // Left the field or reached the sea: its old segments fade out with
      // their layers; it respawns next frame.
      live[p] = 0;
      continue;
    }
    age[p]++;
    const lng = mx[p] * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my[p]))) * 180) / Math.PI;
    const z = elevAtSample() * exag + lift;
    if (hasLast[p]) {
      src[p3] = last[p3] - olng;
      src[p3 + 1] = last[p3 + 1] - olat;
      src[p3 + 2] = last[p3 + 2];
      tgt[p3] = lng - olng;
      tgt[p3 + 1] = lat - olat;
      tgt[p3 + 2] = z;
      const c = colour[near] * 3;
      col[p4] = lut[c];
      col[p4 + 1] = lut[c + 1];
      col[p4 + 2] = lut[c + 2];
      // Fade in after spawning and out at the end of life.
      const a = age[p];
      col[p4 + 3] = 255 * Math.min(1, a / FADE_FRAMES, (life[p] - a) / FADE_FRAMES);
    }
    last[p3] = lng;
    last[p3 + 1] = lat;
    last[p3 + 2] = z;
    hasLast[p] = 1;
  }
}

// ---- Drawing ----------------------------------------------------------

function layerOf(slot, k, ageFrames) {
  return new deck.LineLayer({
    id: `flow-trail-${k}`,
    data: slot.data,
    coordinateSystem: slot.offsets ? deck.COORDINATE_SYSTEM.LNGLAT_OFFSETS : deck.COORDINATE_SYSTEM.LNGLAT,
    coordinateOrigin: [slot.origin[0], slot.origin[1], 0],
    getWidth: flowState.width,
    widthUnits: "pixels",
    opacity: flowState.opacity * (1 - ageFrames / slots.length),
    // Trails never hide one another or the NEXRAD clouds.
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
    pickable: false,
  });
}

function draw() {
  const layers = [];
  const n = slots.length;
  for (let a = n - 1; a >= 0; a--) {
    const k = (head - a + n) % n;
    if (slots[k]) layers.push(layerOf(slots[k], k, a));
  }
  setDeckLayers(OWNER, layers);
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  if (needsAlloc) {
    needsAlloc = false;
    allocate();
  }
  if (!field || !lut) return;
  // Frames at 60 Hz, so the speed doesn't depend on the display's rate; a
  // long gap (a hidden tab) is one frame, not a jump.
  const dt = lastFrame ? Math.min(3, (now - lastFrame) / (1000 / 60)) : 1;
  lastFrame = now;

  head = (head + 1) % slots.length;
  const buf = spare;
  spare = slots[head]?.buf ?? newBuf();
  step(dt, buf);
  slots[head] = {
    buf,
    origin,
    offsets,
    data: {
      length: P,
      attributes: {
        getSourcePosition: { value: buf.src, size: 3 },
        getTargetPosition: { value: buf.tgt, size: 3 },
        getColor: { value: buf.col, size: 4, normalized: true },
      },
    },
  };
  draw();
}

// ---- Start / stop -------------------------------------------------------

export async function startFlowParticles() {
  if (rafId != null) return;
  deck = await loadDeck();
  if (!flowState.active || rafId != null) return;
  allocate();
  setFlowColormap();
  if (flowState.field) installField(flowState.field);
  lastFrame = 0;
  rafId = requestAnimationFrame(frame);
}

// Stop, and let go of every particle and field array.
export function stopFlowParticles() {
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
  field = speed = colour = null;
  mx = my = age = life = live = last = hasLast = null;
  slots = [];
  spare = null;
  P = 0;
  setDeckLayers(OWNER, []);
}

onFlowField((f) => {
  if (rafId != null) installField(f);
});
