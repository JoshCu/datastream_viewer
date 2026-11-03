// ====================================================================
// Surface-flow routing over a DEM grid, for the flow particles (src/flow/).
//
// Pure: no DOM, no map. Runs in src/flow/flow.worker.js on one mosaic of DEM
// tiles (row-major, `w` × `h` cells, metres). Steps:
//
// 1. Priority-Flood + ε (Barnes et al. 2014): flood inward from the outlets
//    (the grid edge, and sea/no-data cells) in order of elevation, raising
//    every pit and flat just enough that each cell has a strictly lower path
//    out, so pits and lakes drain through their spill point instead of
//    trapping water. Each cell's receiver is then its steepest-descent
//    neighbour on the filled surface (on a filled flat, the neighbour it was
//    flooded from, which leads to the spill point).
// 2. Flow accumulation: summed down the receiver tree in topological order.
//    That's what makes rivers stand out.
// 3. Direction: on hillslopes, the downhill gradient of the filled surface
//    (Horn's 3×3, so it's smooth, not 8-way); in channels and on filled flats,
//    the receiver direction, which follows the drainage network. The blend
//    moves from one to the other as accumulation grows, then one 3×3 pass
//    smooths the D8 zig-zag along channels.
// 4. Slope: the filled surface's gradient magnitude, floored by the drop to
//    the receiver, as √S for the speed (Manning's v ∝ S^½).
// ====================================================================

// No-data (NaN) and ground at or below this elevation are outlets: that's
// where water ends, in the sea or in a basin with no way out (Death Valley,
// the Dead Sea, the Salton Sink), rather than filling it to a spill point
// it doesn't have.
const SEA_LEVEL_M = 0;
// Accumulation (cells) at which the direction is half gradient, half receiver.
const CHANNEL_CELLS = 24;
// Receiver steps the receiver direction looks ahead (see routeFlow).
const LOOKAHEAD = 8;
// Below this filled-surface slope the gradient carries no direction (a filled
// flat), so the receiver direction is used alone.
const MIN_GRADIENT_SLOPE = 1e-4;
// Below this drop (m, per unit cell distance) a neighbour is "level" with a
// cell: on filled flats the flood's own receiver is kept. Under a terrarium
// quantum (1/256 m), so any real slope in the data counts.
const FLAT_DROP_M = 1e-3;
// Rise added per cell across a filled flat, so it still drains (metres; the
// fill is float64, so this can be tiny without being lost to rounding).
const FLAT_EPSILON_M = 1e-5;

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

// The flood's queue is a bucket queue of cell indices keyed by elevation,
// inlined in drainageTree: O(1) push and pop, where a binary heap's log n
// made the flood most of the routing time. Keys are binned `width` apart, at
// least the finest DEM quantum (terrarium's 1/256 m), so the order is a
// heap's except among cells a quantum apart. Any order keeps the receivers a
// tree (each cell's filled level is above the one it was flooded from); the
// binning only lets a fill come out up to `width` off.
const BUCKET_WIDTH_M = 1 / 256;
const MAX_BUCKETS = 1 << 21;
const SQRT1_2 = Math.SQRT1_2;

// Steps 1–2: the drainage tree of `elev` (Float32Array(w*h), metres, NaN for
// no data). Returns { filled, receiver, outlet, acc, order }:
//   filled   Float64Array(wh)  the depression-filled surface
//   receiver Int32Array(wh)    the cell each drains to; -1 at an outlet or
//                              the grid edge (it drains off the field)
//   outlet   Uint8Array(wh)    1 where water leaves the field (sea, no data)
//   acc      Float32Array(wh)  upstream area in cells, self included
//   order    Int32Array(wh)    every cell, each before its receiver (so
//                              read backwards, receivers come first)
// data/workers/hand.js walks `order` backwards for height above drainage.
export function drainageTree(elev, w, h) {
  const n = w * h;
  const filled = new Float64Array(n);
  // OPEN marks a cell the flood hasn't reached (rather than a separate
  // "closed" array: 1 byte a cell less).
  const OPEN = -2;
  const receiver = new Int32Array(n).fill(OPEN);
  const outlet = new Uint8Array(n);
  for (let i = 0; i < n; i++) outlet[i] = elev[i] > SEA_LEVEL_M ? 0 : 1; // NaN too
  let lo = SEA_LEVEL_M;
  let hi = SEA_LEVEL_M;
  for (let i = 0; i < n; i++) {
    const e = elev[i];
    if (e < lo) lo = e;
    else if (e > hi) hi = e;
  }
  const width = Math.max(BUCKET_WIDTH_M, (hi - lo) / (MAX_BUCKETS - 1));
  const nb = Math.floor((hi - lo) / width) + 1;
  const head = new Int32Array(nb).fill(-1); // bucket -> last cell pushed
  const next = new Int32Array(n); // cell -> the cell pushed before it
  let queued = 0;
  let cursor = nb; // the lowest bucket that may be non-empty
  const push = (key, c) => {
    let b = Math.floor((key - lo) / width);
    b = b < 0 ? 0 : b >= nb ? nb - 1 : b;
    next[c] = head[b];
    head[b] = c;
    if (b < cursor) cursor = b;
    queued++;
  };
  // Cells raised to the level of the cell they were flooded from: they're
  // inside a pit or flat, so they're processed before anything higher in the
  // queue (but not before a queued cell at the same level, so each of several
  // tied outlets floods its own share of a flat).
  const pit = new Int32Array(n);
  let pitHead = 0;
  let pitTail = 0;

  // Seed: every edge cell and every sea / no-data cell.
  for (let i = 0; i < n; i++) {
    const x = i % w;
    if (outlet[i] || x === 0 || i < w || x === w - 1 || i >= n - w) {
      filled[i] = outlet[i] ? SEA_LEVEL_M : elev[i];
      receiver[i] = -1;
      push(filled[i], i);
    }
  }

  // Neighbour offsets, in DX/DY order, for cells off the grid edge.
  const NB = Int32Array.of(1, w + 1, w, w - 1, -1, -w - 1, -w, -w + 1);
  for (;;) {
    let c;
    if (queued) while (head[cursor] < 0) cursor++;
    if (pitHead < pitTail && !(queued && lo + cursor * width <= filled[pit[pitHead]])) {
      c = pit[pitHead++];
    } else if (queued) {
      c = head[cursor];
      head[cursor] = next[c];
      queued--;
    } else break;
    const cx = c % w;
    const interior = cx > 0 && cx < w - 1 && c >= w && c < n - w;
    const lift = filled[c] + FLAT_EPSILON_M;
    for (let k = 0; k < 8; k++) {
      let j;
      if (interior) j = c + NB[k];
      else {
        const x = cx + DX[k];
        const y = (c - cx) / w + DY[k];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        j = y * w + x;
      }
      if (receiver[j] !== OPEN) continue;
      receiver[j] = c;
      const e = elev[j];
      if (e <= lift) {
        filled[j] = lift;
        pit[pitTail++] = j;
      } else {
        filled[j] = e;
        push(e, j);
      }
    }
  }

  // The flood's receiver is a cell's *lowest* neighbour, which on a slope
  // a little off a grid axis is always the diagonal, ~40° off the fall line.
  // Re-pick the steepest descent (drop / distance) over the filled surface;
  // on a filled flat, where every drop is ~ε, keep the flood's, which leads
  // to the spill point. Filled elevation strictly falls along either, so the
  // result is still a tree. Only interior cells have a receiver here (the
  // edge was seeded), so the neighbours need no bounds checks.
  for (let i = 0; i < n; i++) {
    if (receiver[i] < 0 || outlet[i]) continue;
    const fi = filled[i];
    let best = -1;
    let bestS = 0;
    for (let k = 0; k < 8; k++) {
      const j = i + NB[k];
      const s = (k & 1 ? SQRT1_2 : 1) * (fi - filled[j]);
      if (s > bestS) {
        bestS = s;
        best = j;
      }
    }
    if (best >= 0 && bestS > FLAT_DROP_M) receiver[i] = best;
  }

  // Upstream area, in topological order (Kahn: a cell is summed into its
  // receiver once all of its own donors have been).
  const acc = new Float32Array(n).fill(1);
  const donors = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (receiver[i] >= 0) donors[receiver[i]]++;
  const queue = pit; // free again
  let qHead = 0;
  let qTail = 0;
  for (let i = 0; i < n; i++) if (!donors[i]) queue[qTail++] = i;
  while (qHead < qTail) {
    const i = queue[qHead++];
    const r = receiver[i];
    if (r < 0) continue;
    acc[r] += acc[i];
    if (--donors[r] === 0) queue[qTail++] = r;
  }
  return { filled, receiver, outlet, acc, order: queue };
}

// `elev`: Float32Array(w*h), metres, NaN for no data. `cellM`: Float32Array(h),
// metres per cell on each row (Web Mercator's scale varies with latitude).
// Returns { dir, sqrtSlope, acc, outlet }:
//   dir       Float32Array(2wh)  unit downhill direction (x right, y down)
//   sqrtSlope Float32Array(wh)   √(slope), m/m
//   acc       Float32Array(wh)   upstream area in cells, self included
//   outlet    Uint8Array(wh)     1 where water leaves the field (sea, no data)
export function routeFlow(elev, w, h, cellM) {
  const n = w * h;
  const { filled, receiver, outlet, acc } = drainageTree(elev, w, h);

  const raw = new Float32Array(2 * n);
  const sqrtSlope = new Float32Array(n);
  const at = (x, y) => filled[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    const m = cellM[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (outlet[i]) continue;
      // Horn's gradient of the filled surface (dz/dx right, dz/dy down).
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const d = at(x - 1, y), f = at(x + 1, y);
      const g = at(x - 1, y + 1), hh = at(x, y + 1), ii = at(x + 1, y + 1);
      const gx = (c + 2 * f + ii - (a + 2 * d + g)) / (8 * m);
      const gy = (g + 2 * hh + ii - (a + 2 * b + c)) / (8 * m);
      const gs = Math.hypot(gx, gy);

      // Receiver direction: toward the cell LOOKAHEAD steps down the
      // receiver chain, not the next one. That's less 8-way quantised, and
      // neighbours whose receivers converge on one cell point past it rather
      // than at it, so the interpolated field doesn't stall there. Edge cells
      // have no receiver: they drain off the grid, outward.
      let rx, ry, drop = 0;
      const r = receiver[i];
      if (r >= 0) {
        const qx = r % w;
        drop = (filled[i] - filled[r]) / (Math.hypot(qx - x, (r - qx) / w - y) * m);
        let t = r;
        for (let k = 1; k < LOOKAHEAD && receiver[t] >= 0; k++) t = receiver[t];
        const tx = t % w;
        rx = tx - x;
        ry = (t - tx) / w - y;
        const len = Math.hypot(rx, ry);
        rx /= len;
        ry /= len;
      } else {
        rx = x === 0 ? -1 : x === w - 1 ? 1 : 0;
        ry = y === 0 ? -1 : y === h - 1 ? 1 : 0;
        const len = Math.hypot(rx, ry) || 1;
        rx /= len;
        ry /= len;
      }

      // Gradient weight: 1 on bare hillslope, falling off into channels, and
      // 0 where the gradient is flat or disagrees with the drainage.
      let wg = 0;
      let ux = 0, uy = 0;
      if (gs > MIN_GRADIENT_SLOPE) {
        ux = -gx / gs;
        uy = -gy / gs;
        if (ux * rx + uy * ry > 0) wg = CHANNEL_CELLS / (CHANNEL_CELLS + acc[i]);
      }
      let vx = wg * ux + (1 - wg) * rx;
      let vy = wg * uy + (1 - wg) * ry;
      const len = Math.hypot(vx, vy) || 1;
      raw[2 * i] = vx / len;
      raw[2 * i + 1] = vy / len;
      sqrtSlope[i] = Math.sqrt(Math.max(gs, drop));
    }
  }

  // One smoothing pass, each neighbour weighted by √acc so a channel's own
  // cells outvote the hillslope beside it, and only neighbours flowing the
  // same general way count (so the two sides of a ridge don't cancel). A
  // neighbour's weight is capped at the cell's own, so a hillslope cell beside
  // a river bends downstream a little rather than running alongside it.
  const dir = new Float32Array(2 * n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (outlet[i]) continue;
      const ox = raw[2 * i];
      const oy = raw[2 * i + 1];
      const wi = Math.sqrt(acc[i]);
      let sx = ox * wi;
      let sy = oy * wi;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (outlet[j]) continue;
        const jx = raw[2 * j];
        const jy = raw[2 * j + 1];
        if (jx * ox + jy * oy <= 0) continue;
        const wj = Math.min(Math.sqrt(acc[j]), wi) * 0.5;
        sx += jx * wj;
        sy += jy * wj;
      }
      const len = Math.hypot(sx, sy) || 1;
      dir[2 * i] = sx / len;
      dir[2 * i + 1] = sy / len;
    }
  }

  return { dir, sqrtSlope, acc, outlet };
}
