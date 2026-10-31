// ====================================================================
// Flow particles: rain dropped evenly over the screen, running down the
// routed DEM (flow/field.js), drawn as fading trails with deck.gl.
//
// Like a wind map, but the vector field is surface-flow direction, so the
// particles gather into the drainage network and the rivers draw themselves.
// Speed is √(slope), times upstream area^FLOW_MANNING_EXP in Manning mode,
// normalised per field so its 90th percentile moves flowState.speed css px a
// frame whatever the zoom. Colour is upstream area (log) or speed. Each
// particle carries a heading and a speed, keeping flowState.momentum of
// them a frame and taking the rest from the field, so with momentum it
// swings wide on bends.
//
// With the erosion panel open (erosionState):
// - Interaction: the field is split into bins about erosionState.range px
//   across, and each particle's speed is pulled toward last frame's mean
//   speed in its bin, so fast river water carries slow water along.
// - Erosion: the speed a particle loses along the way it was going (none
//   running straight, all of it stopping head-on) erodes the cell it ran
//   into, less on steeper ground (there it's rock; on the flats it's
//   mud), and the particle carries it, dropping a fixed amount a frame where
//   it is and the rest where it ends. The erosion sums into a grid that is
//   applied to the terrain (flow/terrain.js) every erosionState.interval
//   seconds, when the field is rerouted over it.
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
import { map, flowState, erosionState } from "../state.js";
import { FLOW_LIFE_FRAMES, FLOW_LIFT_M } from "../config.js";
import { packFlowCells, FLOW_LUT_SIZE as LUT_SIZE } from "../data/workers/flowcells.js";
import { colormapColors } from "../color/colormaps.js";
import { loadDeck, setDeckLayers, deckDevice } from "../map/deck.js";
import { onFlowField, rebuildFlowField } from "./field.js";
import { createFlowGpu, GPU_NO_QUAD, GPU_MIN_BIN } from "./gpusim.js";
import { addTerrainDelta } from "./terrain.js";

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
// Erodibility is 1 / (1 + hardness · S / REF_SLOPE): at this slope (5%),
// hardness 1 halves it.
const REF_SLOPE = 0.05;

let deck = null;
let gpu = null; // the WebGPU step, or null for the CPU one
let startId = 0; // bumped by every start and stop, so a stale start gives up
let rafId = null;
let lastFrame = 0;
let needsAlloc = false; // the count changed: reallocate at the next frame

// Particles.
let P = 0;
let mx, my; // Float64Array(P): Mercator position
let vx, vy; // Float64Array(P): heading (field direction, smoothed); 0, 0 = none yet
let vs; // Float64Array(P): speed (normalised, as the field's)
let sed; // Float64Array(P): sediment carried, metres
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

// Interaction and erosion (CPU step). Bins: two halves of (sum, count)
// pairs, read last frame's, write this frame's.
let bins = null; // Float64Array(2 · 2 · max bins)
let binHalf = 0;
let parity = 0;
let ero = null; // Float32Array(w*h): metres eroded (−) / deposited (+) since the last commit
let eroded = false; // there's erosion not yet committed (either step)
let lastCommit = 0;
let committing = null; // the GPU readback in flight

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
  vx = new Float64Array(P);
  vy = new Float64Array(P);
  vs = new Float64Array(P);
  sed = new Float64Array(P);
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
  // A field somewhere else: what's been eroded on this one goes to the
  // terrain first (the GPU grid is cleared with the new field's size).
  const moved = prev && (prev.z !== f.z || prev.x0 !== f.x0 || prev.y0 !== f.y0 || prev.w !== f.w || prev.h !== f.h);
  if (moved && eroded) commitErosion();
  field = f;
  if (!gpu && (moved || !ero)) {
    ero = new Float32Array(f.w * f.h);
    binHalf = 2 * Math.ceil(f.w / GPU_MIN_BIN) * Math.ceil(f.h / GPU_MIN_BIN);
    bins = new Float64Array(2 * binHalf);
  }
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
  const rain = erosionState.rain;
  for (let attempt = 0; attempt < 4; attempt++) {
    let x, y;
    const q = spawnQuads;
    if (rain) {
      // In the rain brush while it's held.
      const a = Math.random() * 2 * Math.PI;
      const r = Math.sqrt(Math.random()) * rain.r;
      x = rain.x + r * Math.cos(a);
      y = rain.y + r * Math.sin(a);
    } else if (q) {
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
    vx[p] = vy[p] = vs[p] = sed[p] = 0;
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
// cell decides: water that's reached the sea has left). The speed keeps
// momentum^frames of itself and is pulled toward its bin's mean; the
// heading keeps momentum^(frames per sub-step) of itself each sub-step.
// Interaction and erosion are as in the GPU step (gpusim.js).
const keepBySub = new Float64Array(MAX_SUBSTEPS + 1);
function step(buf, o) {
  const { w, h, x0, y0, scale } = field;
  const { exag, lift } = o;
  const [olng, olat] = origin;
  const { src, tgt, col } = buf;
  const move = o.move;
  const C = cells, Lat = latRow, colr = colour, L = lut;
  const row = 4 * w;
  // Cell centres are at +0.5.
  const ox = x0 + 0.5, oy = y0 + 0.5;
  const xMax = w - 1, yMax = h - 1;
  const keepBy = keepBySub;
  for (let s = 1; s <= MAX_SUBSTEPS; s++) keepBy[s] = o.momentum ** (1 / s);
  const keepSpeed = o.momentum;
  const pull = o.transfer;
  const B = Math.max(GPU_MIN_BIN, o.bin);
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const Bn = bins;
  const rd = (1 - parity) * binHalf, wr = parity * binHalf;
  if (pull > 0) Bn.fill(0, wr, wr + binHalf);
  parity ^= 1;
  const er = o.erosion;
  const rate = er ? er.rate : 0, hard = er ? er.hardness : 0, depo = er ? er.deposit : 0;
  const E = ero, S = field.sqrtSlope;
  for (let p = 0; p < P; p++) {
    const p3 = p * 3;
    const p4 = p * 4;
    col[p4 + 3] = 0;
    if (!live[p] || age[p] >= life[p]) {
      // Aged out: what it carries settles where it is.
      if (er && live[p] && sed[p] > 0) {
        const c = cellAt(mx[p], my[p]);
        if (c >= 0) E[c] += sed[p];
      }
      spawn(p);
    }
    if (!live[p]) continue;
    let x = mx[p], y = my[p];
    let hx = vx[p], hy = vy[p], sp = vs[p], sd = sed[p];
    const v0x = hx * sp, v0y = hy * sp;
    let alive = true, outlet = false;
    // The first sample sets the speed and the sub-steps (sub < 0 until
    // then); the one after the last sub-step only tests for the end and
    // keeps its weights, for the elevation and colour.
    let sub = -1, k = 0, ds = 0, keep = 0;
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
      if (C[4 * near + 2] < 0) { alive = false; outlet = true; break; }
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
        // A new particle starts on the field's heading and speed.
        if (hx === 0 && hy === 0) {
          hx = dx;
          hy = dy;
          sp = spd;
        } else {
          sp = spd + (sp - spd) * keepSpeed;
        }
        if (pull > 0) {
          const b = rd + 2 * (Math.min(bh - 1, Math.floor((gy + 0.5) / B)) * bw + Math.min(bw - 1, Math.floor((gx + 0.5) / B)));
          const n = Bn[b + 1];
          if (n > 0) sp += pull * (Bn[b] / n - sp);
        }
        const cellsMoved = move * sp;
        sub = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(cellsMoved / MAX_STEP_CELLS)));
        ds = cellsMoved / sub / scale;
        keep = keepBy[sub];
      }
      hx = hx * keep + dx * (1 - keep);
      hy = hy * keep + dy * (1 - keep);
      x += hx * ds;
      y += hy * ds;
      k++;
    }
    mx[p] = x;
    my[p] = y;
    if (!alive) {
      // Left the field or reached the sea: its old segments fade out with
      // their layers; it respawns next frame. At the sea, what it carries
      // settles at the mouth.
      if (er && outlet && sd > 0) E[near] += sd;
      live[p] = 0;
      continue;
    }
    age[p]++;
    if (er) {
      const m0 = Math.hypot(v0x, v0y);
      if (m0 > 0) {
        const impact = m0 - (hx * sp * v0x + hy * sp * v0y) / m0;
        if (impact > 0) {
          const sl = S[near];
          const amt = (rate * impact) / (1 + hard * sl * sl);
          // The cell one ahead along the way it was going.
          const ax = Math.floor(x * scale - x0 + v0x / m0);
          const ay = Math.floor(y * scale - y0 + v0y / m0);
          if (ax >= 0 && ay >= 0 && ax < w && ay < h) {
            E[ay * w + ax] -= amt;
            sd += amt;
          }
        }
      }
      const dep = Math.min(sd, depo);
      if (dep > 0) {
        E[near] += dep;
        sd -= dep;
      }
    }
    if (pull > 0) {
      const bx = Math.min(bw - 1, Math.floor((x * scale - x0) / B));
      const by = Math.min(bh - 1, Math.floor((y * scale - y0) / B));
      const b = wr + 2 * (by * bw + bx);
      Bn[b] += sp;
      Bn[b + 1]++;
    }
    vx[p] = hx;
    vy[p] = hy;
    vs[p] = sp;
    sed[p] = sd;
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

// The step's settings for a frame `dt` 60 Hz frames long (both steps take
// the same ones; see gpusim.js's step()).
function stepOptions(dt) {
  const pxPerCell = (512 * 2 ** map.getZoom()) / field.scale;
  const terrain = map.getTerrain();
  const exag = terrain ? terrain.exaggeration ?? 1 : 0;
  const [lifeMin, lifeMax] = FLOW_LIFE_FRAMES;
  const on = erosionState.active;
  const { transfer, rate, hardness, deposit, rain } = erosionState;
  return {
    move: (flowState.speed * dt) / pxPerCell,
    momentum: flowState.momentum ** dt,
    exag,
    lift: FLOW_LIFT_M * Math.max(1, exag),
    lifeMin,
    lifeSpan: lifeMax - lifeMin,
    transfer: on && transfer > 0 ? 1 - (1 - transfer) ** dt : 0,
    bin: Math.round(erosionState.range / pxPerCell),
    erosion: on && (rate > 0 || deposit > 0) ? { rate, hardness: hardness / REF_SLOPE, deposit: deposit * dt } : null,
    brush: rain ? { x: rain.x * field.scale - field.x0, y: rain.y * field.scale - field.y0, r: rain.r * field.scale } : null,
  };
}

// Apply the erosion so far to the terrain (flow/terrain.js), and reroute
// the field over it.
function commitErosion() {
  if (!eroded || !field) return;
  eroded = false;
  const f = field;
  const apply = (grid) => {
    if (grid && addTerrainDelta(f.z, f.tileSize, f.x0, f.y0, f.w, f.h, grid)) rebuildFlowField();
  };
  if (gpu) {
    // Copied and cleared on the GPU now; read back when it's done.
    gpu.takeErosion().then(apply, (err) => console.warn("Flow erosion readback failed", err));
  } else {
    apply(ero);
    ero.fill(0);
  }
}

// The erosion panel is closing: apply what's been eroded now rather than
// at the next interval.
export const commitFlowErosion = commitErosion;

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
  const o = stepOptions(dt);
  if (o.erosion && !eroded) {
    eroded = true;
    lastCommit = now;
  } else if (eroded && now - lastCommit >= erosionState.interval * 1000) {
    lastCommit = now;
    commitErosion();
  }

  if (gpu) {
    gpu.step(o);
    draw(gpu.slots(), trailSlots());
    return;
  }

  head = (head + 1) % slots.length;
  const buf = spare;
  spare = slots[head]?.buf ?? newBuf();
  step(buf, o);
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
  if (flowState.compute === "gpu" && deck.deviceProps.type === "webgpu") {
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

// Switch between the GPU and CPU step: start over with the other one.
export function restartFlowParticles() {
  if (rafId == null) return;
  stopFlowParticles();
  startFlowParticles();
}

// Stop, and let go of every particle and field array.
export function stopFlowParticles() {
  startId++;
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
  // (The GPU's copy is queued before its buffers go.)
  commitErosion();
  eroded = false;
  gpu?.destroy();
  gpu = null;
  field = cells = colour = latRow = ero = bins = null;
  mx = my = vx = vy = vs = sed = age = life = live = last = hasLast = null;
  slots = [];
  spare = null;
  P = 0;
  setDeckLayers(OWNER, []);
}

onFlowField((f) => {
  if (rafId != null) installField(f);
});
