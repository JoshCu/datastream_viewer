// ====================================================================
// NEXRAD Level II (Archive II) decoder → 3D gate positions (pure, worker-side).
//
// File layout: a 24-byte volume header ("AR2V00xx", date, time, ICAO), then
// LDM records, each a 4-byte signed length followed by a bzip2 stream (or raw
// bytes). A decompressed record is a run of messages, each a 12-byte CTM
// header + 16-byte message header. Message 31 (generic digital radar data)
// holds one radial: a data header, pointers to "R" metadata blocks (VOL, ELV,
// RAD) and "D" moment blocks (REF, VEL, SW, ZDR, PHI, RHO, CFP). Every other
// message type sits in a fixed 2432-byte frame. All fields are big-endian.
//
// splitRecords() runs on the main thread (it only reads lengths) so the
// records can be fanned across the worker pool; decodeRecords() turns one
// group of records into per-cut point arrays.
//
// "BIRD" is a pseudo-moment (bird mode): reflectivity gates 5–40 km out whose
// correlation coefficient says they aren't precipitation, as birds/km³, plus
// per-height sums for a vertical profile of density and a VAD fit of
// radial velocity (see nexrad/birds.js for the solve).
// ====================================================================
import { bunzip2 } from "./bzip2.js";

const VOLUME_HEADER_BYTES = 24;
const CTM_BYTES = 12;
const MSG_HEADER_BYTES = 16;
const FIXED_FRAME_BYTES = 2432;

// 4/3-earth beam propagation model.
const EFFECTIVE_EARTH_RADIUS_M = (4 / 3) * 6371000;
const DEG = Math.PI / 180;

// Split a whole Archive II file into its LDM records. Returns the header
// fields plus [start, end) byte ranges for each record payload.
export function splitRecords(bytes) {
  const tag = String.fromCharCode(...bytes.subarray(0, 8));
  if (!tag.startsWith("AR2V") && !tag.startsWith("ARCHIVE2")) {
    throw new Error("Not a NEXRAD Level II file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const icao = String.fromCharCode(...bytes.subarray(20, 24));
  const records = [];
  let off = VOLUME_HEADER_BYTES;
  while (off + 4 <= bytes.length) {
    const size = Math.abs(view.getInt32(off));
    off += 4;
    if (!size) break;
    const end = Math.min(off + size, bytes.length);
    records.push([off, end]);
    off = end;
  }
  return { icao, records };
}

function decompressRecord(bytes) {
  // "BZh" magic: bzip2; anything else is an uncompressed record.
  if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return bunzip2(bytes).data;
  }
  return bytes;
}

const MOMENT_NAMES = ["REF", "VEL", "SW ", "ZDR", "PHI", "RHO", "CFP"];

// ---- Bird mode -----------------------------------------------------------

// Gates nearer than this are ground clutter, farther ones overshoot the
// migration layer.
const BIRD_MIN_RANGE_M = 5000;
const BIRD_MAX_RANGE_M = 40000;
// Rain is ρHV above about 0.95; biology is lower and noisier.
const BIRD_MAX_RHO = 0.95;
// Standard songbird radar cross-section at S-band, cm².
const BIRD_RCS_CM2 = 11;

// Vertical profile: PROFILE_BINS bins of PROFILE_BIN_M, heights above the
// radar. Each bin holds PROFILE_FIELDS additive sums (so batches merge by
// adding): the VAD normal equations for v_r / cos(el) = u·sin(az) + v·cos(az)
// + c, density sum/count, and per-sector sample counts (azimuth coverage).
export const PROFILE_BIN_M = 200;
export const PROFILE_BINS = 15;
export const PROFILE_SECTORS = 8;
export const PF = {
  n: 0, ss: 1, sc: 2, s: 3, cc: 4, c: 5, sv: 6, cv: 7, v: 8,
  densSum: 9, densN: 10, sector0: 11,
};
export const PROFILE_FIELDS = PF.sector0 + PROFILE_SECTORS;

// Reflectivity factor (dBZ) → birds/km³: η = 10^((dBZ + 13.37) / 10) cm²/km³
// at S-band, over one bird's cross-section.
const birdDensity = (dbz) => 10 ** ((dbz + 13.37) / 10) / BIRD_RCS_CM2;

// Value of moment `block` at slant range `r` (m), or NaN if outside its gates
// or flagged (below threshold / range folded). Moments of one radial can have
// different gate spacing, so gates are matched by range, not index.
function gateAt(view, block, r) {
  const g = Math.round((r - block.first) / block.spacing);
  if (g < 0 || g >= block.gates) return NaN;
  const raw = block.wordBits === 16 ? view.getUint16(block.start + g * 2) : view.getUint8(block.start + g);
  return raw < 2 ? NaN : (raw - block.offset) / block.scale;
}

// Add one radial's bird gates as points, and its gates in range to the
// profile sums. Needs REF and RHO; VEL (absent on surveillance-only cuts)
// feeds the VAD.
function addBirdGates(cut, profile, view, radial, siteHeight) {
  const { REF: ref, RHO: rho, VEL: vel } = radial.blocks;
  const { azimuth, elevation } = radial;
  const sinAz = Math.sin(azimuth * DEG);
  const cosAz = Math.cos(azimuth * DEG);
  const sinEl = Math.sin(elevation * DEG);
  const cosEl = Math.cos(elevation * DEG);
  const sector = Math.floor((((azimuth % 360) + 360) % 360) / (360 / PROFILE_SECTORS));
  const ke = EFFECTIVE_EARTH_RADIUS_M;
  const g0 = Math.max(0, Math.ceil((BIRD_MIN_RANGE_M - ref.first) / ref.spacing));
  const g1 = Math.min(ref.gates, Math.floor((BIRD_MAX_RANGE_M - ref.first) / ref.spacing) + 1);
  for (let g = g0; g < g1; g++) {
    const r = ref.first + g * ref.spacing;
    const h = Math.sqrt(r * r + ke * ke + 2 * r * ke * sinEl) - ke;
    const bin = Math.floor(h / PROFILE_BIN_M);
    const raw = ref.wordBits === 16 ? view.getUint16(ref.start + g * 2) : view.getUint8(ref.start + g);
    if (raw === 1) continue; // range folded: unknown
    const p = bin >= 0 && bin < PROFILE_BINS ? bin * PROFILE_FIELDS : -1;
    if (raw === 0) {
      // Below the noise floor: no birds here.
      if (p >= 0) profile[p + PF.densN]++;
      continue;
    }
    const cc = gateAt(view, rho, r);
    if (!(cc < BIRD_MAX_RHO)) continue; // precipitation, or no ρHV to tell
    const density = birdDensity((raw - ref.offset) / ref.scale);
    const s = ke * Math.asin((r * cosEl) / (ke + h));
    cut.x.push(s * sinAz);
    cut.y.push(s * cosAz);
    cut.z.push(h + siteHeight);
    cut.v.push(density);
    if (p < 0) continue;
    profile[p + PF.densSum] += density;
    profile[p + PF.densN]++;
    const vr = vel ? gateAt(view, vel, r) : NaN;
    if (Number.isNaN(vr)) continue;
    const y = vr / cosEl;
    profile[p + PF.n]++;
    profile[p + PF.ss] += sinAz * sinAz;
    profile[p + PF.sc] += sinAz * cosAz;
    profile[p + PF.s] += sinAz;
    profile[p + PF.cc] += cosAz * cosAz;
    profile[p + PF.c] += cosAz;
    profile[p + PF.sv] += sinAz * y;
    profile[p + PF.cv] += cosAz * y;
    profile[p + PF.v] += y;
    profile[p + PF.sector0 + sector]++;
  }
  cut.angleSum += elevation;
  cut.radials++;
}

// ---- Radials -------------------------------------------------------------

// Parse one message-31 radial at `p` (start of its data header): its
// geometry, the VOL site block (if present) and the moment blocks by name.
function readRadial(view, bytes, p, end) {
  const azimuth = view.getFloat32(p + 12);
  const elevNum = bytes[p + 22];
  const elevation = view.getFloat32(p + 24);
  const blockCount = view.getUint16(p + 30);
  let site = null;
  const blocks = {};
  for (let b = 0; b < Math.min(blockCount, 10); b++) {
    const q = p + view.getUint32(p + 32 + b * 4);
    if (q + 28 > end) continue;
    const kind = bytes[q];
    const name = String.fromCharCode(bytes[q + 1], bytes[q + 2], bytes[q + 3]);
    if (kind === 0x52 && name === "VOL") {
      site = {
        lat: view.getFloat32(q + 8),
        lon: view.getFloat32(q + 12),
        height: view.getInt16(q + 16) + view.getUint16(q + 18),
        vcp: view.getUint16(q + 40),
      };
    } else if (kind === 0x44) {
      const gates = view.getUint16(q + 8);
      const wordBits = bytes[q + 19];
      if (q + 28 + gates * (wordBits / 8) > end) continue;
      blocks[name] = {
        gates,
        first: view.getUint16(q + 10), // m to the first gate's centre
        spacing: view.getUint16(q + 12), // m
        wordBits,
        scale: view.getFloat32(q + 20),
        offset: view.getFloat32(q + 24),
        start: q + 28,
      };
    }
  }
  return { azimuth, elevNum, elevation, site, blocks };
}

// Growable float column.
function column() {
  let a = new Float32Array(4096);
  let n = 0;
  return {
    push(v) {
      if (n === a.length) {
        const next = new Float32Array(a.length * 2);
        next.set(a);
        a = next;
      }
      a[n++] = v;
    },
    done: () => a.slice(0, n),
  };
}

function cutColumns(elevNum) {
  return { elevNum, angleSum: 0, radials: 0, x: column(), y: column(), z: column(), v: column() };
}

// Append every valid gate of one radial as a point. x/y are metres east/north
// of the radar, z metres above sea level (beam centre, 4/3-earth model).
function addGates(cut, view, radial, data, siteHeight) {
  const { azimuth, elevation } = radial;
  const sinAz = Math.sin(azimuth * DEG);
  const cosAz = Math.cos(azimuth * DEG);
  const sinEl = Math.sin(elevation * DEG);
  const cosEl = Math.cos(elevation * DEG);
  const ke = EFFECTIVE_EARTH_RADIUS_M;
  const wide = data.wordBits === 16;
  for (let g = 0; g < data.gates; g++) {
    const raw = wide ? view.getUint16(data.start + g * 2) : view.getUint8(data.start + g);
    if (raw < 2) continue; // 0 = below threshold, 1 = range folded
    const r = data.first + g * data.spacing;
    const h = Math.sqrt(r * r + ke * ke + 2 * r * ke * sinEl) - ke;
    const s = ke * Math.asin((r * cosEl) / (ke + h));
    cut.x.push(s * sinAz);
    cut.y.push(s * cosAz);
    cut.z.push(h + siteHeight);
    cut.v.push((raw - data.offset) / data.scale);
  }
  cut.angleSum += elevation;
  cut.radials++;
}

// Decode a group of LDM records (`buffer` holds them back to back, `ranges`
// their [start, end) offsets) and collect the `moment` gates per elevation
// cut. Returns { site, cuts: [{ elevNum, angleSum, radials, x, y, z, v }] },
// plus `profile` (PROFILE_BINS × PROFILE_FIELDS sums) for "BIRD".
export function decodeRecords(buffer, ranges, moment) {
  const birds = moment === "BIRD";
  if (!birds && !MOMENT_NAMES.includes(moment)) throw new Error(`Unknown moment ${moment}`);
  const src = new Uint8Array(buffer);
  const cuts = new Map();
  const profile = birds ? new Float64Array(PROFILE_BINS * PROFILE_FIELDS) : null;
  let site = null;
  for (const [start, stop] of ranges) {
    const bytes = decompressRecord(src.subarray(start, stop));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    while (off + CTM_BYTES + MSG_HEADER_BYTES <= bytes.length) {
      const h = off + CTM_BYTES;
      const sizeHalfwords = view.getUint16(h);
      const type = bytes[h + 3];
      if (type === 31 && sizeHalfwords) {
        const end = Math.min(h + sizeHalfwords * 2, bytes.length);
        const radial = readRadial(view, bytes, h + MSG_HEADER_BYTES, end);
        if (radial.site) site = radial.site;
        const { blocks } = radial;
        const usable = birds ? blocks.REF && blocks.RHO : blocks[moment];
        if (usable && site) {
          let cut = cuts.get(radial.elevNum);
          if (!cut) cuts.set(radial.elevNum, (cut = cutColumns(radial.elevNum)));
          if (birds) addBirdGates(cut, profile, view, radial, site.height);
          else addGates(cut, view, radial, blocks[moment], site.height);
        }
        off = h + sizeHalfwords * 2;
      } else {
        off += FIXED_FRAME_BYTES;
      }
    }
  }
  return {
    site,
    profile,
    cuts: [...cuts.values()].map((c) => ({
      elevNum: c.elevNum,
      angleSum: c.angleSum,
      radials: c.radials,
      x: c.x.done(),
      y: c.y.done(),
      z: c.z.done(),
      v: c.v.done(),
    })),
  };
}
