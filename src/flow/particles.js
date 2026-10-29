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
//
// On WebGPU the step runs as a compute shader instead (flow/gpusim.js),
// writing the trail buffers deck draws; this module still owns the
// settings, the field, the spawn grid and the ring's drawing.
// ====================================================================
import { map, flowState } from "../state.js";
import { FLOW_LIFE_FRAMES, FLOW_LIFT_M } from "../config.js";
import { packFlowCells, FLOW_LUT_SIZE as LUT_SIZE } from "../data/workers/flowcells.js";
import { colormapColors } from "../color/colormaps.js";
import { loadDeck, setDeckLayers, deckDevice } from "../map/deck.js";
import { onFlowField } from "./field.js";
import { createFlowGpu, GPU_NO_QUAD } from "./gpusim.js";

const OWNER = "flow";
const OVERLAY_PROPS = { useDevicePixels: 1 };
// Frames a particle takes to fade in after spawning, and out before dying.
const FADE_FRAMES = 12;
// Largest move per sub-step, in field cells, so a fast particle doesn't
// jump a ridge or a channel.
const MAX_STEP_CELLS = 0.75;
const MAX_SUBSTEPS = 6;
// Spawn grid: the screen is unprojected at (n+1)² points after each move, and
// spawns pick a random grid quad, so rain is even on screen even when pitched.
const SPAWN_GRID = 16;
// Field spans (degrees of latitude) below which positions are offsets.
const OFFSET_SPAN_DEG = 2;

let deck = null;
let gpu = null; // the WebGPU step, or null for the CPU one
let startId = 0; // bumped by every start and stop, so a stale start gives up
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
let cells = null; // Float32Array(4wh): per cell [dirX, dirY, ±speed, elev]
let colour = null; // Uint8Array(w*h): LUT index per cell
let latRow = null; // Float64Array(h+2): latitude of each row's top edge
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
  gpu?.setLut(lut);
}

const newBuf = () => ({
  src: new Float32Array(P * 3),
  tgt: new Float32Array(P * 3),
  col: new Uint8Array(P * 4),
});

const trailSlots = () => Math.max(1, flowState.trail - 1);

function allocate() {
  P = flowState.count;
  if (gpu) {
    gpu.allocate(P, trailSlots());
    return;
  }
  mx = new Float64Array(P);
  my = new Float64Array(P);
  age = new Int32Array(P);
  life = new Int32Array(P);
  live = new Uint8Array(P);
  last = new Float64Array(P * 3);
  hasLast = new Uint8Array(P);
  slots = new Array(trailSlots()).fill(null);
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
  const n = trailSlots();
  if (gpu) {
    // Its ring is positions; starting it over costs a second of trails.
    gpu.resizeRing(n);
    return;
  }
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

// Repack the field's cells for the current speed model and colour-by (the
// worker packs a new field for the settings it was asked with).
export function updateFlowCells() {
  if (!field) return;
  ({ cells, colour } = packFlowCells(field, flowState.speedModel, flowState.colorBy));
  gpu?.setColour(colour, cells);
}

const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

function installField(f) {
  const prev = field;
  field = f;
  // Settings changed while it was being built: repack.
  if (f.speedModel === flowState.speedModel && f.colorBy === flowState.colorBy) {
    ({ cells, colour } = f);
  } else {
    ({ cells, colour } = packFlowCells(f, flowState.speedModel, flowState.colorBy));
  }
  // Row-edge latitudes, interpolated per particle in place of atan(sinh()).
  latRow = new Float64Array(f.h + 2);
  for (let r = 0; r < latRow.length; r++) latRow[r] = latOf((f.y0 + r) / f.scale);
  // Centre of the field, for offset positions.
  const cx = (f.x0 + f.w / 2) / f.scale;
  const cy = (f.y0 + f.h / 2) / f.scale;
  const span = latOf(f.y0 / f.scale) - latOf((f.y0 + f.h) / f.scale);
  // Each layer keeps the origin it was written with, so this can move freely.
  offsets = span < OFFSET_SPAN_DEG;
  origin = offsets ? [cx * 360 - 180, latOf(cy)] : [0, 0];
  if (gpu) {
    // Its positions are in field cells: x' = x·k + c moves them to this one.
    const k = prev ? f.scale / prev.scale : 1;
    const lat = new Float32Array(latRow.length);
    for (let r = 0; r < lat.length; r++) lat[r] = latRow[r] - origin[1];
    const geo = {
      lngPerCell: 360 / f.scale,
      lngOff: (f.x0 * 360) / f.scale - 180 - origin[0],
      origin,
      offsets,
    };
    gpu.setField(f, cells, colour, lat, geo, k, prev ? prev.x0 * k - f.x0 : 0, prev ? prev.y0 * k - f.y0 : 0);
  }
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
  if (gpu && field) {
    // In field cells for the GPU.
    const q = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const ok = Number.isFinite(pts[i]);
      q[i] = ok ? pts[i] * field.scale - field.x0 : GPU_NO_QUAD;
      q[i + 1] = ok ? pts[i + 1] * field.scale - field.y0 : GPU_NO_QUAD;
    }
    gpu.setQuads(q);
  }
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

// Move every particle one frame and write its segment (where it was drawn
// last frame → where it is now) into `buf`. This is most of a frame's CPU
// time, so the sampling is inlined with everything it reads in locals:
// bilinear direction and speed from the packed `cells` (data/workers/
// flowcells.js), and an end off the field or over an outlet (the nearest
// cell decides: water that's reached the sea has left).
function step(dtFrames, buf) {
  const { w, h, x0, y0, scale } = field;
  // css px per field cell at the map's current zoom.
  const pxPerCell = (512 * 2 ** map.getZoom()) / scale;
  const terrain = map.getTerrain();
  const exag = terrain ? terrain.exaggeration ?? 1 : 0;
  const lift = FLOW_LIFT_M * Math.max(1, exag);
  const [olng, olat] = origin;
  const { src, tgt, col } = buf;
  const move = (flowState.speed * dtFrames) / pxPerCell;
  const C = cells, Lat = latRow, colr = colour, L = lut;
  const row = 4 * w;
  // Cell centres are at +0.5.
  const ox = x0 + 0.5, oy = y0 + 0.5;
  const xMax = w - 1, yMax = h - 1;
  for (let p = 0; p < P; p++) {
    const p3 = p * 3;
    const p4 = p * 4;
    col[p4 + 3] = 0;
    if (!live[p] || age[p] >= life[p]) spawn(p);
    if (!live[p]) continue;
    let x = mx[p], y = my[p];
    let alive = true;
    // The first sample sets the sub-steps (sub < 0 until then); the one
    // after the last sub-step only tests for the end and keeps its weights,
    // for the elevation and colour.
    let sub = -1, k = 0, ds = 0;
    let a = 0, near = 0, w00 = 0, w10 = 0, w01 = 0, w11 = 0;
    for (;;) {
      const gx = x * scale - ox;
      const gy = y * scale - oy;
      if (!(gx >= 0 && gy >= 0 && gx <= xMax && gy <= yMax)) { alive = false; break; }
      const ix = Math.min(w - 2, Math.floor(gx));
      const iy = Math.min(h - 2, Math.floor(gy));
      const tx = gx - ix;
      const ty = gy - iy;
      const i00 = iy * w + ix;
      near = i00 + (tx < 0.5 ? 0 : 1) + (ty < 0.5 ? 0 : w);
      if (C[4 * near + 2] < 0) { alive = false; break; }
      w00 = (1 - tx) * (1 - ty);
      w10 = tx * (1 - ty);
      w01 = (1 - tx) * ty;
      w11 = tx * ty;
      a = 4 * i00;
      if (k === sub) break;
      const c = a + row;
      const dx = C[a] * w00 + C[a + 4] * w10 + C[c] * w01 + C[c + 4] * w11;
      const dy = C[a + 1] * w00 + C[a + 5] * w10 + C[c + 1] * w01 + C[c + 5] * w11;
      if (sub < 0) {
        // Outlet neighbours carry their speed negated.
        const spd =
          Math.abs(C[a + 2]) * w00 + Math.abs(C[a + 6]) * w10 +
          Math.abs(C[c + 2]) * w01 + Math.abs(C[c + 6]) * w11;
        const cellsMoved = move * spd;
        sub = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(cellsMoved / MAX_STEP_CELLS)));
        ds = cellsMoved / sub / scale;
      }
      x += dx * ds;
      y += dy * ds;
      k++;
    }
    mx[p] = x;
    my[p] = y;
    if (!alive) {
      // Left the field or reached the sea: its old segments fade out with
      // their layers; it respawns next frame.
      live[p] = 0;
      continue;
    }
    age[p]++;
    const lng = x * 360 - 180;
    const gr = y * scale - y0;
    const r0 = Math.floor(gr);
    const lat = Lat[r0] + (Lat[r0 + 1] - Lat[r0]) * (gr - r0);
    const c = a + row;
    const z = (C[a + 3] * w00 + C[a + 7] * w10 + C[c + 3] * w01 + C[c + 7] * w11) * exag + lift;
    if (hasLast[p]) {
      src[p3] = last[p3] - olng;
      src[p3 + 1] = last[p3 + 1] - olat;
      src[p3 + 2] = last[p3 + 2];
      tgt[p3] = lng - olng;
      tgt[p3 + 1] = lat - olat;
      tgt[p3 + 2] = z;
      const ci = colr[near] * 3;
      col[p4] = L[ci];
      col[p4 + 1] = L[ci + 1];
      col[p4 + 2] = L[ci + 2];
      // Fade in after spawning and out at the end of life.
      const ag = age[p];
      col[p4 + 3] = 255 * Math.min(1, ag / FADE_FRAMES, (life[p] - ag) / FADE_FRAMES);
    }
    last[p3] = lng;
    last[p3 + 1] = lat;
    last[p3 + 2] = z;
    hasLast[p] = 1;
  }
}

// ---- Drawing ----------------------------------------------------------

function layerOf(slot, k, ageFrames, n) {
  return new deck.LineLayer({
    id: `flow-trail-${k}`,
    visible: !slot.hidden,
    data: slot.data,
    coordinateSystem: slot.offsets ? deck.COORDINATE_SYSTEM.LNGLAT_OFFSETS : deck.COORDINATE_SYSTEM.LNGLAT,
    coordinateOrigin: [slot.origin[0], slot.origin[1], 0],
    getWidth: flowState.width,
    widthUnits: "pixels",
    opacity: flowState.opacity * Math.max(0, 1 - ageFrames / n),
    // Trails never hide one another or the NEXRAD clouds.
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
    pickable: false,
  });
}

// Draw the ring: `ring` oldest first, as { key, data, origin, offsets,
// hidden }, the last `n` of it a trail's worth of frames.
function draw(ring, n) {
  const layers = ring.map((s, i) => layerOf(s, s.key, ring.length - 1 - i, n));
  // At css px, not device px: a quarter of the fragments on a 2× screen
  // for thin translucent lines that hardly look different.
  setDeckLayers(OWNER, layers, OVERLAY_PROPS);
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

  if (gpu) {
    const pxPerCell = (512 * 2 ** map.getZoom()) / field.scale;
    const terrain = map.getTerrain();
    const exag = terrain ? terrain.exaggeration ?? 1 : 0;
    const [lifeMin, lifeMax] = FLOW_LIFE_FRAMES;
    gpu.step((flowState.speed * dt) / pxPerCell, exag, FLOW_LIFT_M * Math.max(1, exag), lifeMin, lifeMax - lifeMin);
    draw(gpu.slots(), trailSlots());
    return;
  }

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
  const ring = [];
  const n = slots.length;
  for (let a = n - 1; a >= 0; a--) {
    const k = (head - a + n) % n;
    if (slots[k]) ring.push({ key: k, ...slots[k] });
  }
  draw(ring, n);
}

// ---- Start / stop -------------------------------------------------------

export async function startFlowParticles() {
  if (rafId != null) return;
  const id = ++startId;
  deck = await loadDeck();
  if (id !== startId) return;
  if (deck.deviceProps.type === "webgpu") {
    // The overlay's own device; if the shader won't build there, the CPU.
    try {
      const device = await deckDevice(OWNER, OVERLAY_PROPS);
      // (deck falls back to WebGL2 if the WebGPU device fails.)
      const g =
        device.type === "webgpu" &&
        (await createFlowGpu(device, {
          grid: SPAWN_GRID,
          fade: FADE_FRAMES,
          maxStep: MAX_STEP_CELLS,
          maxSub: MAX_SUBSTEPS,
        }));
      if (id !== startId) return g && g.destroy();
      gpu = g || null;
    } catch (err) {
      console.warn("Flow particles: WebGPU step unavailable, using the CPU", err);
    }
    if (id !== startId) return;
  }
  if (!flowState.active) return;
  console.info(`flow: particles stepped on the ${gpu ? "GPU" : "CPU"}`);
  allocate();
  setFlowColormap();
  if (flowState.field) installField(flowState.field);
  lastFrame = 0;
  rafId = requestAnimationFrame(frame);
}

// Stop, and let go of every particle and field array.
export function stopFlowParticles() {
  startId++;
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
  gpu?.destroy();
  gpu = null;
  field = cells = colour = latRow = null;
  mx = my = age = life = live = last = hasLast = null;
  slots = [];
  spare = null;
  P = 0;
  setDeckLayers(OWNER, []);
}

onFlowField((f) => {
  if (rafId != null) installField(f);
});
