// ====================================================================
// Height above nearest drainage (HAND) over a DEM mosaic, for flood
// inundation mapping (src/fim/).
//
// Pure: no DOM, no map. Runs in src/flow/flow.worker.js on the same mosaic
// the flow field is built from. Steps:
//
// 1. Burn: rasterize the reach polylines into the grid (8-connected, so D8
//    can follow them) and lower those cells BURN_M before routing, so the
//    drainage follows the mapped rivers (OWP's hydro-conditioning does the
//    same). Where reaches cross a cell, the higher stream order keeps it, so
//    a main stem stays continuous through its confluences.
// 2. Route: Priority-Flood + steepest descent (drainageTree in flowroute.js).
// 3. HAND: walk the tree from the outlets up (the topological order read
//    backwards). A burned cell is its own drainage: it records its own
//    (unburned) elevation and reach. Every other cell takes both from its
//    receiver. HAND = ground − drainage elevation.
//
// A cell whose path leaves the grid, or reaches the sea, without crossing a
// burned line has no reach (0) and NaN HAND.
// ====================================================================
import { drainageTree } from "./flowroute.js";

// How far burned cells are lowered before routing (m). Enough to beat the
// DEM's noise and a levee or road fill beside a channel; it never shows in
// HAND, which is measured on the unburned ground.
const BURN_M = 10;

// Rasterize segment (ax, ay) → (bx, by) in grid cells (floating point,
// cell centres at +0.5) as an 8-connected run of cells, calling put(i).
function rasterSegment(ax, ay, bx, by, w, h, put) {
  let x = Math.floor(ax);
  let y = Math.floor(ay);
  const x1 = Math.floor(bx);
  const y1 = Math.floor(by);
  const dx = Math.abs(x1 - x);
  const dy = Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x >= 0 && y >= 0 && x < w && y < h) put(y * w + x);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

// `lines`: { offsets: Int32Array(nLines + 1), xy: Float32Array (grid-cell
// x, y pairs), reach: Int32Array(nLines) (1-based reach number), rank:
// Float32Array(nLines) (higher wins a shared cell) }. Returns
// Uint32Array(w*h): the reach number burned into each cell, 0 if none.
export function burnLines(lines, w, h) {
  const burn = new Uint32Array(w * h);
  const rankAt = new Float32Array(w * h).fill(-Infinity);
  const { offsets, xy, reach, rank } = lines;
  for (let l = 0; l < reach.length; l++) {
    const r = reach[l];
    const k = rank[l];
    const put = (i) => {
      if (k > rankAt[i]) {
        rankAt[i] = k;
        burn[i] = r;
      }
    };
    const a = offsets[l];
    const b = offsets[l + 1];
    if (b - a === 1) {
      rasterSegment(xy[2 * a], xy[2 * a + 1], xy[2 * a], xy[2 * a + 1], w, h, put);
      continue;
    }
    for (let p = a; p < b - 1; p++) {
      rasterSegment(xy[2 * p], xy[2 * p + 1], xy[2 * p + 2], xy[2 * p + 3], w, h, put);
    }
  }
  return burn;
}

// `elev`: Float32Array(w*h), metres, NaN for no data. `burn`: from
// burnLines. Returns { hand: Float32Array(wh) (m, NaN where no reach),
// reach: Uint32Array(wh) (the reach number each cell drains to, 0 if none) }.
export function computeHand(elev, w, h, burn) {
  const n = w * h;
  const conditioned = new Float32Array(elev);
  for (let i = 0; i < n; i++) if (burn[i]) conditioned[i] -= BURN_M;
  const { receiver, order } = drainageTree(conditioned, w, h);

  const drain = new Float32Array(n).fill(NaN);
  const reach = new Uint32Array(n);
  const hand = new Float32Array(n).fill(NaN);
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    if (burn[i]) {
      drain[i] = elev[i];
      reach[i] = burn[i];
    } else {
      const r = receiver[i];
      if (r < 0) continue;
      drain[i] = drain[r];
      reach[i] = reach[r];
    }
    // Ground below its drainage (a pit the fill raised, or the DEM dipping
    // under a burned line's own cell) counts as at the channel.
    if (reach[i]) hand[i] = Math.max(0, elev[i] - drain[i]);
  }
  return { hand, reach };
}
