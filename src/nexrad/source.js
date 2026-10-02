// ====================================================================
// NEXRAD Level II scans from the public Unidata/NOAA bucket.
//
// Keys are YYYY/MM/DD/<ICAO>/<ICAO>YYYYMMDD_HHMMSS_V06 (older years: _V03.gz,
// with _MDM metadata-only files alongside). A volume is fetched whole (~5-15
// MB), split into its LDM records here, and the records are fanned across the
// shared parse-worker pool, since bzip2 decoding dominates the load. The
// workers return per-cut gate arrays, merged below.
// ====================================================================
import { listS3All, objectUrl } from "../s3/client.js";
import { runTask } from "../data/loader.js";
import { splitRecords } from "../data/workers/nexrad.js";

export const NEXRAD_BUCKET = "unidata-nexrad-level2";

// Cuts closer than this (degrees) are the same tilt scanned twice: the split
// cuts of the low tilts (surveillance + Doppler) and SAILS re-scans of 0.5°.
export const SAME_TILT_DEG = 0.25;

const datePrefix = (date) => `${date.replaceAll("-", "/")}/`;

// Station ICAOs with data on `date` (YYYY-MM-DD).
export async function listStations(date) {
  const { folders } = await listS3All(datePrefix(date), NEXRAD_BUCKET);
  return folders;
}

// The volume scans of one station-day, oldest first: [{ key, url, time }].
export async function listScans(date, station) {
  const { keys } = await listS3All(`${datePrefix(date)}${station}/`, NEXRAD_BUCKET);
  return keys
    .filter((k) => !k.endsWith("_MDM") && !k.endsWith(".tar"))
    .map((key) => ({ key, url: objectUrl(NEXRAD_BUCKET, key), time: scanTime(key) }))
    .filter((s) => s.time != null);
}

// KTLX20240507_000047_V06 → epoch ms.
function scanTime(key) {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(key.split("/").pop());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// Fetch with byte progress.
async function download(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  let bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  if (url.endsWith(".gz")) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

// Group consecutive records into about `n` byte-balanced batches, each copied
// into its own buffer (so it can be transferred) with rebased ranges.
function batches(bytes, records, n) {
  const total = records.reduce((s, [a, b]) => s + b - a, 0);
  const target = total / n;
  const out = [];
  let group = [];
  let size = 0;
  const flush = () => {
    if (!group.length) return;
    const buf = new Uint8Array(size);
    let off = 0;
    const ranges = group.map(([a, b]) => {
      buf.set(bytes.subarray(a, b), off);
      off += b - a;
      return [off - (b - a), off];
    });
    out.push({ buffer: buf.buffer, ranges });
    group = [];
    size = 0;
  };
  for (const r of records) {
    group.push(r);
    size += r[1] - r[0];
    if (size >= target) flush();
  }
  flush();
  return out;
}

const concat = (arrays) => {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

// Join the per-batch cuts (a cut can straddle batches), drop repeated tilts
// (first scan of each angle wins) and order by angle.
function mergeCuts(parts) {
  const byElev = new Map();
  for (const part of parts) {
    for (const c of part.cuts) {
      const m = byElev.get(c.elevNum) ?? { elevNum: c.elevNum, angleSum: 0, radials: 0, cols: [] };
      m.angleSum += c.angleSum;
      m.radials += c.radials;
      m.cols.push(c);
      byElev.set(c.elevNum, m);
    }
  }
  const kept = [];
  for (const m of [...byElev.values()].sort((a, b) => a.elevNum - b.elevNum)) {
    const angle = m.angleSum / m.radials;
    if (kept.some((k) => Math.abs(k.angle - angle) < SAME_TILT_DEG)) continue;
    kept.push({
      angle,
      x: concat(m.cols.map((c) => c.x)),
      y: concat(m.cols.map((c) => c.y)),
      z: concat(m.cols.map((c) => c.z)),
      v: concat(m.cols.map((c) => c.v)),
    });
  }
  return kept.sort((a, b) => a.angle - b.angle);
}

// The last download per station, so switching moments re-decodes without
// re-fetching. Several radars can be on screen, so it's keyed by ICAO (the
// file name's first four letters); a new scan of a station replaces its old one.
const cache = new Map(); // icao → { url, bytes }
const icaoOf = (url) => url.split("/").pop().slice(0, 4);

// Let go of a station's cached download (its radar was removed).
export function forgetStation(icao) {
  cache.delete(icao);
}

// Add up the batches' bird-profile sums (null unless the moment is BIRD).
function mergeProfiles(parts) {
  const profiles = parts.map((p) => p.profile).filter(Boolean);
  if (!profiles.length) return null;
  const out = new Float64Array(profiles[0].length);
  for (const p of profiles) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

// Load one scan's `moment` (REF, VEL, ZDR, RHO, …, or BIRD). Returns
// { icao, site: { lat, lon, height, vcp }, time, moment, cuts, profile }.
export async function loadVolume(url, moment, onProgress) {
  const key = icaoOf(url);
  let cached = cache.get(key);
  if (cached?.url !== url) {
    cache.delete(key); // let the old scan go before downloading
    cached = { url, bytes: await download(url, onProgress) };
    cache.set(key, cached);
  }
  const { icao, records } = splitRecords(cached.bytes);
  const n = Math.min(records.length, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
  const parts = await Promise.all(
    batches(cached.bytes, records, n).map(({ buffer, ranges }) =>
      runTask({ type: "nexrad", buffer, ranges, moment }, [buffer]),
    ),
  );
  const site = parts.find((p) => p.site)?.site;
  const cuts = mergeCuts(parts);
  if (!site || !cuts.length) {
    if (moment === "BIRD") throw new Error("No dual-pol data in this scan (needed for bird mode)");
    throw new Error(`No ${moment} data in this scan (pre-2008 files aren't supported)`);
  }
  return { icao, site, time: scanTime(url), moment, cuts, profile: mergeProfiles(parts) };
}
