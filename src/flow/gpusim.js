// ====================================================================
// The flow particles' step as a WebGPU compute shader, on deck.gl's own
// device, so the trail buffers it writes are drawn as they are: nothing is
// uploaded per frame, and the CPU does no per-particle work. Used when the
// flow overlay runs on WebGPU; particles.js keeps the CPU step otherwise.
//
// It's the same model as the CPU step (particles.js), with these
// differences forced by the GPU:
// - A particle's position is in field cells (x right, y down, from the
//   field's corner), as f32, which Mercator in f32 isn't precise enough
//   for. A new field remaps them (pos·k + c, with c worked out in f64).
// - The trail ring is positions, not segments: ring slot i holds where every
//   particle was at the end of that frame (and its colour then), and its
//   layer draws from slot i−1's positions to slot i's. That's one position
//   per particle per frame rather than two. A slot's segments need both
//   ends in the same origin, so a frame whose origin differs from the last
//   one's draws none (one missing segment in each trail).
// - deck draws the layers we give it a frame late at times: it takes a new
//   layer list only in its own animation-loop callback, but a camera move
//   makes MapLibre's `render` redraw deck at once with the list it has. So
//   no layer in the list before last may use the slot a step overwrites
//   (else its segments run from where each particle is now to where it was
//   a trail ago: lines across the screen while panning), and a dropped ring
//   buffer is destroyed only once deck can't draw it (RETIRE_FRAMES).
// - deck's line positions are float64 attributes: each 3-float position is
//   followed by a 3-float low part, left at 0 (stride 24). On WebGPU each
//   attribute must also start within its stride, so every ring slot is
//   its own buffer rather than an offset into one.
// - Random numbers are a hash of the particle and the frame.
// - Speed bins (particle interaction) and erosion are summed with atomics,
//   in fixed point (SPEED_SCALE, ERODE_SCALE). A frame reads last frame's
//   bins and writes this frame's (two halves, swapped each frame); the
//   erosion grid is read back and cleared by takeErosion().
// ====================================================================

const WORKGROUP = 64;
// Ring buffer pairs beyond the drawn trail: the one the next step writes,
// and the oldest drawn layer's start, which deck may still draw from the
// list before last.
const SPARE_SLOTS = 2;
// Frames before a dropped ring buffer is destroyed: deck may draw the list
// that used it for one more frame.
const RETIRE_FRAMES = 3;
// A spawn quad corner above the horizon.
export const GPU_NO_QUAD = -1e30;
// Fixed point for the atomic sums: speed (≤ ~3) and erosion (metres).
const SPEED_SCALE = 1024;
const ERODE_SCALE = 10000;
// Smallest speed bin, in field cells, so the bins are at most a quarter of
// the cells.
export const GPU_MIN_BIN = 2;

const SHADER = /* wgsl */ `
struct U {
  w: u32, h: u32, count: u32, frame: u32,
  speed: f32, exag: f32, lift: f32, lngPerCell: f32,
  lngOff: f32, lifeMin: f32, lifeSpan: f32, quads: u32,
  noSegment: u32, remapK: f32, remapX: f32, remapY: f32,
  grid: u32, fade: f32, maxStep: f32, maxSub: f32,
  momentum: f32, transfer: f32, bin: u32, bw: u32,
  bh: u32, binHalf: u32, parity: u32, erode: u32,
  rate: f32, hardness: f32, deposit: f32, slopeOff: u32,
  latOff: u32, quadOff: u32, brushOn: u32, brushR: f32,
  brushX: f32, brushY: f32, erodeOff: u32, _pad: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<uniform> lut: array<vec4u, 64>;           // 0xBBGGRR
@group(0) @binding(2) var<storage, read> cells: array<vec4f>;        // dirX, dirY, ±speed, elev
// LUT index per cell (4 per word) | √slope per cell | row-edge lat − origin
// lat | spawn grid (field cells): one buffer, as WebGPU allows only 8
// storage buffers per stage.
@group(0) @binding(3) var<storage, read> aux: array<u32>;
@group(0) @binding(4) var<storage, read_write> state: array<vec4f>;  // x, y, age, life (0 = waiting)
@group(0) @binding(5) var<storage, read_write> motion: array<vec4f>; // heading x, y, speed, sediment
@group(0) @binding(6) var<storage, read_write> pos: array<f32>;      // lng, lat, z, 0, 0, 0
@group(0) @binding(7) var<storage, read_write> col: array<u32>;      // RGBA8
// Speed bins, two halves (this frame's, last frame's) of (sum, count) |
// erosion per cell, fixed point, two's complement.
@group(0) @binding(8) var<storage, read_write> acc: array<atomic<u32>>;

const SPEED_SCALE = ${SPEED_SCALE}.0;
const ERODE_SCALE = ${ERODE_SCALE}.0;

fn hash(v: u32) -> u32 {
  var x = v * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}
fn rnd(s: ptr<function, u32>) -> f32 {
  *s = hash(*s);
  return f32(*s >> 8u) / 16777216.0;
}
fn quad(i: u32) -> vec2f {
  return vec2f(bitcast<f32>(aux[u.quadOff + 2u * i]), bitcast<f32>(aux[u.quadOff + 2u * i + 1u]));
}
fn latAt(r: u32) -> f32 {
  return bitcast<f32>(aux[u.latOff + r]);
}
// Add m metres to the cell under g (field cells), if it's on the field.
fn addElev(g: vec2f, m: f32) {
  if (!(g.x >= 0.0 && g.y >= 0.0 && g.x < f32(u.w) && g.y < f32(u.h))) { return; }
  let i = u32(g.y) * u.w + u32(g.x);
  atomicAdd(&acc[u.erodeOff + i], bitcast<u32>(i32(round(m * ERODE_SCALE))));
}
// The (sum, count) pair of the speed bin under g in half h.
fn binAt(g: vec2f, h: u32) -> u32 {
  let bx = min(u32(max(g.x, 0.0)) / u.bin, u.bw - 1u);
  let by = min(u32(max(g.y, 0.0)) / u.bin, u.bh - 1u);
  return h * u.binHalf + 2u * (by * u.bw + bx);
}

// A random land cell: in the rain brush while it's held, else a random
// point in a random spawn quad (so rain is even on screen, even pitched), or
// anywhere on the field without a spawn grid. life 0 if four tries all
// missed.
fn spawn(seed: ptr<function, u32>) -> vec4f {
  let n = u.grid + 1u;
  for (var attempt = 0u; attempt < 4u; attempt++) {
    var g: vec2f;
    if (u.brushOn != 0u) {
      let a = rnd(seed) * 6.2831853;
      let r = sqrt(rnd(seed)) * u.brushR;
      g = vec2f(u.brushX, u.brushY) + r * vec2f(cos(a), sin(a));
    } else if (u.quads != 0u) {
      let i = min(u32(rnd(seed) * f32(u.grid)), u.grid - 1u);
      let j = min(u32(rnd(seed) * f32(u.grid)), u.grid - 1u);
      let a = j * n + i;
      let qa = quad(a);
      let qb = quad(a + 1u);
      let qc = quad(a + n);
      let qd = quad(a + n + 1u);
      let fu = rnd(seed);
      let fv = rnd(seed);
      if (min(min(qa.x, qb.x), min(qc.x, qd.x)) < -1e29) { continue; }
      g = mix(mix(qa, qb, fu), mix(qc, qd, fu), fv);
    } else {
      g = vec2f(rnd(seed) * f32(u.w), rnd(seed) * f32(u.h));
    }
    if (!(g.x >= 0.0 && g.y >= 0.0 && g.x < f32(u.w) && g.y < f32(u.h))) { continue; }
    let cell = u32(g.y) * u.w + u32(g.x);
    if (cells[cell].z < 0.0) { continue; }
    return vec4f(g, 0.0, u.lifeMin + floor(rnd(seed) * u.lifeSpan));
  }
  return vec4f(0.0);
}

@compute @workgroup_size(${WORKGROUP})
fn step(@builtin(global_invocation_id) id: vec3u) {
  let p = id.x;
  if (p >= u.count) { return; }
  var s = state[p];
  s = vec4f(s.xy * u.remapK + vec2f(u.remapX, u.remapY), s.zw);
  var m = motion[p];
  var fresh = false;
  if (s.w <= 0.0 || s.z >= s.w) {
    // Aged out: what it carries settles where it is.
    if (u.erode != 0u && s.w > 0.0 && m.w > 0.0) { addElev(s.xy, m.w); }
    var seed = hash(p ^ hash(u.frame));
    s = spawn(&seed);
    m = vec4f(0.0);
    fresh = true;
  }
  if (s.w <= 0.0) {
    state[p] = s;
    motion[p] = m;
    col[p] = 0u;
    return;
  }

  // The first sample sets the speed and the sub-steps (sub < 0 until then);
  // the one after the last sub-step only tests for the end and keeps its
  // weights. Off the field or over an outlet (the nearest cell decides)
  // ends the particle. The speed keeps u.momentum of itself (already per
  // this frame's length) and is pulled toward last frame's mean in its bin;
  // the heading keeps momentum^(1/sub) of itself each sub-step.
  var x = s.x;
  var y = s.y;
  var hd = m.xy;
  var sp = m.z;
  var sd = m.w;
  let v0 = hd * sp;
  var keep = 0.0;
  var alive = true;
  var outlet = false;
  var sub = -1;
  var k = 0;
  var ds = 0.0;
  var i00 = 0u;
  var near = 0u;
  var wt = vec4f(0.0);
  let xMax = f32(u.w - 1u);
  let yMax = f32(u.h - 1u);
  loop {
    let gx = x - 0.5;
    let gy = y - 0.5;
    if (!(gx >= 0.0 && gy >= 0.0 && gx <= xMax && gy <= yMax)) { alive = false; break; }
    let ix = min(u.w - 2u, u32(gx));
    let iy = min(u.h - 2u, u32(gy));
    let tx = gx - f32(ix);
    let ty = gy - f32(iy);
    i00 = iy * u.w + ix;
    near = i00 + select(0u, 1u, tx >= 0.5) + select(0u, u.w, ty >= 0.5);
    if (cells[near].z < 0.0) { alive = false; outlet = true; break; }
    wt = vec4f((1.0 - tx) * (1.0 - ty), tx * (1.0 - ty), (1.0 - tx) * ty, tx * ty);
    if (k == sub) { break; }
    let c00 = cells[i00];
    let c10 = cells[i00 + 1u];
    let c01 = cells[i00 + u.w];
    let c11 = cells[i00 + u.w + 1u];
    let d = c00.xy * wt.x + c10.xy * wt.y + c01.xy * wt.z + c11.xy * wt.w;
    if (sub < 0) {
      // Outlet neighbours carry their speed negated.
      let spd = abs(c00.z) * wt.x + abs(c10.z) * wt.y + abs(c01.z) * wt.z + abs(c11.z) * wt.w;
      // A new particle starts on the field's heading and speed.
      if (hd.x == 0.0 && hd.y == 0.0) {
        hd = d;
        sp = spd;
      } else {
        sp = mix(spd, sp, u.momentum);
      }
      if (u.transfer > 0.0) {
        let b = binAt(vec2f(x, y), 1u - u.parity);
        let n = atomicLoad(&acc[b + 1u]);
        if (n > 0u) { sp += u.transfer * (f32(atomicLoad(&acc[b])) / SPEED_SCALE / f32(n) - sp); }
      }
      let moved = u.speed * sp;
      sub = i32(clamp(ceil(moved / u.maxStep), 1.0, u.maxSub));
      ds = moved / f32(sub);
      keep = select(pow(u.momentum, 1.0 / f32(sub)), 0.0, u.momentum <= 0.0);
    }
    hd = mix(d, hd, keep);
    x += hd.x * ds;
    y += hd.y * ds;
    k++;
  }
  if (!alive) {
    // Reached the sea: what it carries settles at the mouth. Off the field,
    // it's gone. Respawns next frame.
    if (outlet && u.erode != 0u && sd > 0.0) {
      addElev(vec2f(f32(near % u.w) + 0.5, f32(near / u.w) + 0.5), sd);
    }
    state[p] = vec4f(x, y, s.z, 0.0);
    motion[p] = vec4f(0.0);
    col[p] = 0u;
    return;
  }
  let age = s.z + 1.0;
  state[p] = vec4f(x, y, age, s.w);

  if (u.erode != 0u) {
    // The speed it lost along the way it was going: none running straight,
    // all of it stopping head-on. That much (less on steeper, harder
    // ground) is taken from the cell it ran into and carried.
    let m0 = length(v0);
    if (m0 > 0.0) {
      let impact = m0 - dot(hd * sp, v0) / m0;
      if (impact > 0.0) {
        let sl = bitcast<f32>(aux[u.slopeOff + near]);
        let amt = u.rate * impact / (1.0 + u.hardness * sl * sl);
        addElev(vec2f(x, y) + v0 / m0, -amt);
        sd += amt;
      }
    }
    let dep = min(sd, u.deposit);
    if (dep > 0.0) {
      addElev(vec2f(x, y), dep);
      sd -= dep;
    }
  }
  if (u.transfer > 0.0) {
    let b = binAt(vec2f(x, y), u.parity);
    atomicAdd(&acc[b], u32(sp * SPEED_SCALE));
    atomicAdd(&acc[b + 1u], 1u);
  }
  motion[p] = vec4f(hd, sp, sd);

  let e = cells[i00].w * wt.x + cells[i00 + 1u].w * wt.y +
    cells[i00 + u.w].w * wt.z + cells[i00 + u.w + 1u].w * wt.w;
  let r = min(u32(y), u.h);
  let o = p * 6u;
  pos[o] = x * u.lngPerCell + u.lngOff;
  pos[o + 1u] = latAt(r) + (latAt(r + 1u) - latAt(r)) * (y - f32(r));
  pos[o + 2u] = e * u.exag + u.lift;

  // A segment needs last frame's position, in the same origin.
  var c = 0u;
  if (!fresh && u.noSegment == 0u) {
    let ci = (aux[near >> 2u] >> ((near & 3u) * 8u)) & 255u;
    let rgb = lut[ci >> 2u][ci & 3u];
    // Fade in after spawning and out at the end of life.
    let a = clamp(min(age / u.fade, (s.w - age) / u.fade), 0.0, 1.0);
    c = rgb | (u32(a * 255.0) << 24u);
  }
  col[p] = c;
}
`;

const UNIFORM_BYTES = 160;
// Given with an external float64 attribute's buffer, a Float32Array `value`
// is what tells deck (DataColumn) that on WebGPU the buffer holds each
// position's low part after it, rather than binding the low part as a
// constant, which WebGPU can't do. It's never read or uploaded.
const INTERLEAVED_LOW = new Float32Array(3);

// `device`: deck's luma device (WebGPU). Rejects if the pipeline doesn't
// build, so the caller can fall back to the CPU.
export async function createFlowGpu(device, { grid, fade, maxStep, maxSub }) {
  const gpu = device.handle;
  const module = gpu.createShaderModule({ code: SHADER });
  const pipeline = await gpu.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "step" },
  });
  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const raw = (size, usage) => gpu.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
  const uniforms = raw(UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const lutBuf = raw(1024, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const u = new ArrayBuffer(UNIFORM_BYTES);
  const uu = new Uint32Array(u);
  const uf = new Float32Array(u);
  const quadWords = (grid + 1) ** 2 * 2;

  let cellBuf = null, auxBuf = null, accBuf = null, stateBuf = null, motionBuf = null;
  let w = 0, h = 0, P = 0;
  // aux layout (u32 words): colour | √slope | latitudes | quads.
  let slopeOff = 0, latOff = 0, quadOff = 0;
  // acc layout (u32 words): bins half 0 | bins half 1 | erosion.
  let binHalf = 0, erodeOff = 0;
  let parity = 0;
  let lngPerCell = 0, lngOff = 0, origin = null, offsets = false;
  let hasQuads = false;
  let quads = null; // the last spawn grid, rewritten into a new aux buffer
  // Pending remap of particle positions to a new field: pos·k + (cx, cy).
  let remap = [1, 0, 0];
  // The ring: R = trail + SPARE_SLOTS position/colour buffer pairs (luma
  // Buffers, for deck), `cur` the newest, with each slot's origin and layer
  // data; `trail` of them are drawn.
  let ring = [];
  let trail = 0;
  let retired = []; // [{ buffers, frame }] waiting until deck can't draw them
  let cur = 0;
  let frame = 0;
  let lastOrigin = null;
  let bindGroups = [];

  const replace = (old, size, usage) => {
    old?.destroy();
    return raw(size, usage);
  };

  function freeRing() {
    if (ring.length) retired.push({ buffers: ring.flatMap((s) => [s.pos, s.col]), frame });
    ring = [];
    bindGroups = [];
  }

  function destroyRetired(all) {
    retired = retired.filter((r) => {
      if (!all && frame - r.frame < RETIRE_FRAMES) return true;
      for (const b of r.buffers) b.destroy();
      return false;
    });
  }

  function slotData(i) {
    const R = ring.length;
    const s = ring[i];
    const src = ring[(i - 1 + R) % R];
    return {
      length: P,
      attributes: {
        getSourcePosition: { buffer: src.pos, value: INTERLEAVED_LOW, type: "float32", size: 3, stride: 24 },
        getTargetPosition: { buffer: s.pos, value: INTERLEAVED_LOW, type: "float32", size: 3, stride: 24 },
        getColor: { buffer: s.col, type: "unorm8", size: 4 },
      },
    };
  }

  function bindGroup(i) {
    if (!bindGroups[i]) {
      const entries = [uniforms, lutBuf, cellBuf, auxBuf, stateBuf, motionBuf, ring[i].pos.handle, ring[i].col.handle, accBuf];
      bindGroups[i] = gpu.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    }
    return bindGroups[i];
  }

  // writeBuffer wants a multiple of 4 bytes.
  function writeBytes(buf, offset, bytes) {
    const n4 = Math.floor(bytes.byteLength / 4) * 4;
    if (n4) gpu.queue.writeBuffer(buf, offset, bytes.buffer, bytes.byteOffset, n4);
    if (n4 < bytes.byteLength) {
      const tail = new Uint8Array(4);
      tail.set(bytes.subarray(n4));
      gpu.queue.writeBuffer(buf, offset + n4, tail);
    }
  }

  return {
    // Particle count and trail length: everyone starts over (state is
    // zeroed, so every particle spawns on the next step).
    allocate(count, trail) {
      P = count;
      stateBuf = replace(stateBuf, P * 16, GPUBufferUsage.STORAGE);
      motionBuf = replace(motionBuf, P * 16, GPUBufferUsage.STORAGE);
      remap = [1, 0, 0];
      this.resizeRing(trail);
    },

    // A new ring of `n` drawn slots (the trails so far are dropped).
    resizeRing(n) {
      freeRing();
      trail = n;
      const usage = GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE;
      for (let i = 0; i < trail + SPARE_SLOTS; i++) {
        ring.push({
          pos: device.createBuffer({ byteLength: Math.max(24, P * 24), usage }),
          col: device.createBuffer({ byteLength: Math.max(4, P * 4), usage }),
          origin: [0, 0],
          offsets: false,
          data: null,
        });
      }
      for (let i = 0; i < ring.length; i++) ring[i].data = slotData(i);
      cur = 0;
      lastOrigin = null;
    },

    // A new field: its packed cells, colour and √slope, the row-edge
    // latitudes less the origin's, and lng = x·lngPerCell + lngOff (x in
    // field cells). `k`, `cx`, `cy` (f64) remap positions from the last
    // field: x' = x·k + cx. A field of another size starts the bins and
    // the erosion grid over: takeErosion() first to keep its erosion.
    setField(f, cells, colour, latRows, geo, k, cx, cy) {
      const n = f.w * f.h;
      if (f.w !== w || f.h !== h || !accBuf) {
        w = f.w;
        h = f.h;
        binHalf = 2 * Math.ceil(w / GPU_MIN_BIN) * Math.ceil(h / GPU_MIN_BIN);
        erodeOff = 2 * binHalf;
        accBuf = replace(accBuf, (erodeOff + n) * 4, STORAGE | GPUBufferUsage.COPY_SRC);
      }
      cellBuf = replace(cellBuf, cells.byteLength, STORAGE);
      gpu.queue.writeBuffer(cellBuf, 0, cells);
      slopeOff = Math.ceil(n / 4);
      latOff = slopeOff + n;
      quadOff = latOff + latRows.length;
      auxBuf = replace(auxBuf, (quadOff + quadWords) * 4, STORAGE);
      gpu.queue.writeBuffer(auxBuf, slopeOff * 4, f.sqrtSlope);
      gpu.queue.writeBuffer(auxBuf, latOff * 4, latRows);
      if (quads) gpu.queue.writeBuffer(auxBuf, quadOff * 4, quads);
      ({ lngPerCell, lngOff, origin, offsets } = geo);
      this.setColour(colour);
      // Compose with a remap not yet applied (two fields between steps).
      remap = [remap[0] * k, remap[1] * k + cx, remap[2] * k + cy];
    },

    // New LUT indices per cell (and speeds, when `cells` is given).
    setColour(colour, cells) {
      if (cells) gpu.queue.writeBuffer(cellBuf, 0, cells);
      writeBytes(auxBuf, 0, colour);
      bindGroups = [];
    },

    // `lut`: Uint8Array(256·3) RGB.
    setLut(lut) {
      const packed = new Uint32Array(256);
      for (let i = 0; i < 256; i++) packed[i] = lut[3 * i] | (lut[3 * i + 1] << 8) | (lut[3 * i + 2] << 16);
      gpu.queue.writeBuffer(lutBuf, 0, packed);
    },

    // Spawn grid corners in field cells (GPU_NO_QUAD above the horizon), or
    // null to spawn anywhere on the field.
    setQuads(q) {
      hasQuads = !!q;
      quads = q;
      if (q && auxBuf) gpu.queue.writeBuffer(auxBuf, quadOff * 4, q);
    },

    // One frame. `o`:
    //   move      field cells moved at speed 1
    //   momentum  share of its speed (and heading) a particle keeps over it
    //   exag, lift, lifeMin, lifeSpan
    //   transfer  share of the gap to its bin's mean speed closed (0 = off)
    //   bin       speed bin size, field cells (≥ GPU_MIN_BIN)
    //   erosion   null, or { rate, hardness, deposit } (hardness per unit
    //             slope, deposit metres this frame)
    //   brush     null, or { x, y, r } in field cells: spawn there
    step(o) {
      destroyRetired(false);
      if (!cellBuf || !ring.length) return;
      cur = (cur + 1) % ring.length;
      // (Absolute positions have origin [0, 0], which no field centre is.)
      const sameOrigin = lastOrigin && lastOrigin[0] === origin[0] && lastOrigin[1] === origin[1];
      ring[cur].origin = origin;
      ring[cur].offsets = offsets;
      const bin = Math.max(GPU_MIN_BIN, o.bin);
      const er = o.erosion;
      uu[0] = w; uu[1] = h; uu[2] = P; uu[3] = frame++;
      uf[4] = o.move; uf[5] = o.exag; uf[6] = o.lift; uf[7] = lngPerCell;
      uf[8] = lngOff; uf[9] = o.lifeMin; uf[10] = o.lifeSpan; uu[11] = hasQuads ? 1 : 0;
      uu[12] = sameOrigin ? 0 : 1; uf[13] = remap[0]; uf[14] = remap[1]; uf[15] = remap[2];
      uu[16] = grid; uf[17] = fade; uf[18] = maxStep; uf[19] = maxSub;
      uf[20] = o.momentum; uf[21] = o.transfer; uu[22] = bin; uu[23] = Math.ceil(w / bin);
      uu[24] = Math.ceil(h / bin); uu[25] = binHalf; uu[26] = parity; uu[27] = er ? 1 : 0;
      uf[28] = er?.rate ?? 0; uf[29] = er?.hardness ?? 0; uf[30] = er?.deposit ?? 0; uu[31] = slopeOff;
      uu[32] = latOff; uu[33] = quadOff; uu[34] = o.brush ? 1 : 0; uf[35] = o.brush?.r ?? 0;
      uf[36] = o.brush?.x ?? 0; uf[37] = o.brush?.y ?? 0; uu[38] = erodeOff;
      remap = [1, 0, 0];
      lastOrigin = origin;
      gpu.queue.writeBuffer(uniforms, 0, u);
      const enc = gpu.createCommandEncoder();
      // This frame's bins start empty; last frame's are read.
      if (o.transfer > 0) enc.clearBuffer(accBuf, parity * binHalf * 4, binHalf * 4);
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup(cur));
      pass.dispatchWorkgroups(Math.ceil(P / WORKGROUP));
      pass.end();
      gpu.queue.submit([enc.finish()]);
      parity ^= 1;
    },

    // The erosion since the last call, metres per field cell (w × h), and
    // start it over. Null without a field.
    async takeErosion() {
      if (!accBuf) return null;
      const bytes = w * h * 4;
      const read = gpu.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = gpu.createCommandEncoder();
      enc.copyBufferToBuffer(accBuf, erodeOff * 4, read, 0, bytes);
      enc.clearBuffer(accBuf, erodeOff * 4, bytes);
      gpu.queue.submit([enc.finish()]);
      try {
        await read.mapAsync(GPUMapMode.READ);
        const fixed = new Int32Array(read.getMappedRange());
        const out = new Float32Array(fixed.length);
        for (let i = 0; i < fixed.length; i++) out[i] = fixed[i] / ERODE_SCALE;
        read.unmap();
        return out;
      } finally {
        read.destroy();
      }
    },

    // Every slot, oldest first: { key, data, origin, offsets, hidden }, the
    // newest `trail` drawn. All of them, hidden or not, so the layer ids
    // stay the same from frame to frame and deck never rebuilds a layer.
    slots() {
      const R = ring.length;
      const out = [];
      for (let a = R - 1; a >= 0; a--) {
        const i = (cur - a + R) % R;
        out.push({ key: i, ...ring[i], hidden: a >= trail });
      }
      return out;
    },

    // Free everything. The ring goes RETIRE_FRAMES animation frames later,
    // once deck has dropped the layers drawing it.
    destroy() {
      freeRing();
      let n = RETIRE_FRAMES;
      const tick = () => (n-- > 0 ? requestAnimationFrame(tick) : destroyRetired(true));
      tick();
      for (const b of [uniforms, lutBuf, cellBuf, auxBuf, accBuf, stateBuf, motionBuf]) b?.destroy();
      cellBuf = auxBuf = accBuf = stateBuf = motionBuf = null;
    },
  };
}
