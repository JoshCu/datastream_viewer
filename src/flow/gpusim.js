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

const SHADER = /* wgsl */ `
struct U {
  w: u32, h: u32, count: u32, frame: u32,
  speed: f32, exag: f32, lift: f32, lngPerCell: f32,
  lngOff: f32, lifeMin: f32, lifeSpan: f32, quads: u32,
  noSegment: u32, remapK: f32, remapX: f32, remapY: f32,
  grid: u32, fade: f32, maxStep: f32, maxSub: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<uniform> lut: array<vec4u, 64>;          // 0xBBGGRR
@group(0) @binding(2) var<storage, read> cells: array<vec4f>;       // dirX, dirY, ±speed, elev
@group(0) @binding(3) var<storage, read> colour: array<u32>;        // LUT index, 4 per word
@group(0) @binding(4) var<storage, read> latRow: array<f32>;        // row-edge lat − origin lat
@group(0) @binding(5) var<storage, read> quads: array<vec2f>;       // spawn grid, field cells
@group(0) @binding(6) var<storage, read_write> state: array<vec4f>; // x, y, age, life (0 = waiting)
@group(0) @binding(7) var<storage, read_write> pos: array<f32>;     // lng, lat, z, 0, 0, 0
@group(0) @binding(8) var<storage, read_write> col: array<u32>;     // RGBA8

fn hash(v: u32) -> u32 {
  var x = v * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}
fn rnd(s: ptr<function, u32>) -> f32 {
  *s = hash(*s);
  return f32(*s >> 8u) / 16777216.0;
}

// A random land cell: a random point in a random spawn quad (so rain is even
// on screen, even pitched), or anywhere on the field without a spawn grid.
// life 0 if four tries all missed.
fn spawn(seed: ptr<function, u32>) -> vec4f {
  let n = u.grid + 1u;
  for (var attempt = 0u; attempt < 4u; attempt++) {
    var g: vec2f;
    if (u.quads != 0u) {
      let i = min(u32(rnd(seed) * f32(u.grid)), u.grid - 1u);
      let j = min(u32(rnd(seed) * f32(u.grid)), u.grid - 1u);
      let a = j * n + i;
      let qa = quads[a];
      let qb = quads[a + 1u];
      let qc = quads[a + n];
      let qd = quads[a + n + 1u];
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
  var fresh = false;
  if (s.w <= 0.0 || s.z >= s.w) {
    var seed = hash(p ^ hash(u.frame));
    s = spawn(&seed);
    fresh = true;
  }
  if (s.w <= 0.0) {
    state[p] = s;
    col[p] = 0u;
    return;
  }

  // The first sample sets the sub-steps (sub < 0 until then); the one after
  // the last sub-step only tests for the end and keeps its weights. Off the
  // field or over an outlet (the nearest cell decides) ends the particle.
  var x = s.x;
  var y = s.y;
  var alive = true;
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
    if (cells[near].z < 0.0) { alive = false; break; }
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
      let moved = u.speed * spd;
      sub = i32(clamp(ceil(moved / u.maxStep), 1.0, u.maxSub));
      ds = moved / f32(sub);
    }
    x += d.x * ds;
    y += d.y * ds;
    k++;
  }
  if (!alive) {
    // Left the field or reached the sea: respawns next frame.
    state[p] = vec4f(x, y, s.z, 0.0);
    col[p] = 0u;
    return;
  }
  let age = s.z + 1.0;
  state[p] = vec4f(x, y, age, s.w);

  let e = cells[i00].w * wt.x + cells[i00 + 1u].w * wt.y +
    cells[i00 + u.w].w * wt.z + cells[i00 + u.w + 1u].w * wt.w;
  let r = min(u32(y), u.h);
  let o = p * 6u;
  pos[o] = x * u.lngPerCell + u.lngOff;
  pos[o + 1u] = latRow[r] + (latRow[r + 1u] - latRow[r]) * (y - f32(r));
  pos[o + 2u] = e * u.exag + u.lift;

  // A segment needs last frame's position, in the same origin.
  var c = 0u;
  if (!fresh && u.noSegment == 0u) {
    let ci = (colour[near >> 2u] >> ((near & 3u) * 8u)) & 255u;
    let rgb = lut[ci >> 2u][ci & 3u];
    // Fade in after spawning and out at the end of life.
    let a = clamp(min(age / u.fade, (s.w - age) / u.fade), 0.0, 1.0);
    c = rgb | (u32(a * 255.0) << 24u);
  }
  col[p] = c;
}
`;

const UNIFORM_BYTES = 80;
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
  const quadBuf = raw((grid + 1) ** 2 * 8, STORAGE);
  const u = new ArrayBuffer(UNIFORM_BYTES);
  const uu = new Uint32Array(u);
  const uf = new Float32Array(u);

  let cellBuf = null, colourBuf = null, latBuf = null, stateBuf = null;
  let w = 0, h = 0, P = 0;
  let lngPerCell = 0, lngOff = 0, origin = null, offsets = false;
  let hasQuads = false;
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
      const entries = [uniforms, lutBuf, cellBuf, colourBuf, latBuf, quadBuf, stateBuf, ring[i].pos.handle, ring[i].col.handle];
      bindGroups[i] = gpu.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    }
    return bindGroups[i];
  }

  return {
    // Particle count and trail length: everyone starts over (state is
    // zeroed, so every particle spawns on the next step).
    allocate(count, trail) {
      P = count;
      stateBuf = replace(stateBuf, P * 16, GPUBufferUsage.STORAGE);
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

    // A new field: its packed cells and colour, the row-edge latitudes less
    // the origin's, and lng = x·lngPerCell + lngOff (x in field cells).
    // `k`, `cx`, `cy` (f64) remap positions from the last field: x' = x·k + cx.
    setField(f, cells, colour, latRows, geo, k, cx, cy) {
      w = f.w;
      h = f.h;
      cellBuf = replace(cellBuf, cells.byteLength, STORAGE);
      gpu.queue.writeBuffer(cellBuf, 0, cells);
      latBuf = replace(latBuf, latRows.byteLength, STORAGE);
      gpu.queue.writeBuffer(latBuf, 0, latRows);
      ({ lngPerCell, lngOff, origin, offsets } = geo);
      this.setColour(colour);
      // Compose with a remap not yet applied (two fields between steps).
      remap = [remap[0] * k, remap[1] * k + cx, remap[2] * k + cy];
    },

    // New LUT indices per cell (and speeds, when `cells` is given).
    setColour(colour, cells) {
      if (cells) gpu.queue.writeBuffer(cellBuf, 0, cells);
      colourBuf = replace(colourBuf, colour.byteLength, STORAGE);
      // writeBuffer wants a multiple of 4 bytes.
      const n4 = Math.floor(colour.byteLength / 4) * 4;
      if (n4) gpu.queue.writeBuffer(colourBuf, 0, colour.buffer, colour.byteOffset, n4);
      if (n4 < colour.byteLength) {
        const tail = new Uint8Array(4);
        tail.set(colour.subarray(n4));
        gpu.queue.writeBuffer(colourBuf, n4, tail);
      }
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
      if (q) gpu.queue.writeBuffer(quadBuf, 0, q);
    },

    // One frame. `move` is in field cells at speed 1.
    step(move, exag, lift, lifeMin, lifeSpan) {
      destroyRetired(false);
      if (!cellBuf || !ring.length) return;
      cur = (cur + 1) % ring.length;
      // (Absolute positions have origin [0, 0], which no field centre is.)
      const sameOrigin = lastOrigin && lastOrigin[0] === origin[0] && lastOrigin[1] === origin[1];
      ring[cur].origin = origin;
      ring[cur].offsets = offsets;
      uu[0] = w; uu[1] = h; uu[2] = P; uu[3] = frame++;
      uf[4] = move; uf[5] = exag; uf[6] = lift; uf[7] = lngPerCell;
      uf[8] = lngOff; uf[9] = lifeMin; uf[10] = lifeSpan; uu[11] = hasQuads ? 1 : 0;
      uu[12] = sameOrigin ? 0 : 1; uf[13] = remap[0]; uf[14] = remap[1]; uf[15] = remap[2];
      uu[16] = grid; uf[17] = fade; uf[18] = maxStep; uf[19] = maxSub;
      remap = [1, 0, 0];
      lastOrigin = origin;
      gpu.queue.writeBuffer(uniforms, 0, u);
      const enc = gpu.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup(cur));
      pass.dispatchWorkgroups(Math.ceil(P / WORKGROUP));
      pass.end();
      gpu.queue.submit([enc.finish()]);
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
      for (const b of [uniforms, lutBuf, quadBuf, cellBuf, colourBuf, latBuf, stateBuf]) b?.destroy();
      cellBuf = colourBuf = latBuf = stateBuf = null;
    },
  };
}
