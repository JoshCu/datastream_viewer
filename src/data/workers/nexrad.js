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

// Parse one message-31 radial at `p` (start of its data header); returns
// null if the requested moment is absent.
function readRadial(view, bytes, p, end, moment) {
  const azimuth = view.getFloat32(p + 12);
  const elevNum = bytes[p + 22];
  const elevation = view.getFloat32(p + 24);
  const blockCount = view.getUint16(p + 30);
  let site = null;
  let data = null;
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
    } else if (kind === 0x44 && name === moment) {
      const gates = view.getUint16(q + 8);
      const wordBits = bytes[q + 19];
      if (q + 28 + gates * (wordBits / 8) > end) continue;
      data = {
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
  return { azimuth, elevNum, elevation, site, data };
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
function addGates(cut, view, radial, siteHeight) {
  const { data, azimuth, elevation } = radial;
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
// cut. Returns { site, cuts: [{ elevNum, angleSum, radials, x, y, z, v }] }.
export function decodeRecords(buffer, ranges, moment) {
  if (!MOMENT_NAMES.includes(moment)) throw new Error(`Unknown moment ${moment}`);
  const src = new Uint8Array(buffer);
  const cuts = new Map();
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
        const radial = readRadial(view, bytes, h + MSG_HEADER_BYTES, end, moment);
        if (radial.site) site = radial.site;
        if (radial.data && site) {
          let cut = cuts.get(radial.elevNum);
          if (!cut) cuts.set(radial.elevNum, (cut = cutColumns(radial.elevNum)));
          addGates(cut, view, radial, site.height);
        }
        off = h + sizeHalfwords * 2;
      } else {
        off += FIXED_FRAME_BYTES;
      }
    }
  }
  return {
    site,
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
