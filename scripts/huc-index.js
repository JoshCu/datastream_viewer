#!/usr/bin/env bun
// Builds hucindex.parquet: every hydrologic unit's code, name and bounds, so the
// search box can find one (data/hucindex.js). Run with:
//   bun scripts/huc-index.js [--zoom 8] [--cache <dir>] [--out <file>]
// then upload it:
//   aws s3 cp dist/hucindex.parquet s3://communityhydrofabric/map/index/hucindex.parquet
//
// huc.pmtiles can only be read by place, and USGS's WBD service was too slow
// and unreliable to search from the browser (504s and 40 s timeouts), so the
// list is built here from the tiles. z8 is the first zoom with every level
// (HUC 12 starts there), about 56 MB of range reads. A lower --zoom costs less
// and gets the levels that have started by then (z5, ~2 MB: down to HUC 8).
// --cache keeps the tiles, for a rerun that fetches only the directories.
// Needs the duckdb CLI, which writes the Parquet.
//
// One row per unit, sorted by code: huc, name ("" if the unit only has its code),
// west, south, east, north as DECIMAL(6,3) degrees. A unit across the antimeridian
// has east > 180. ZSTD with V2 delta pages was the smallest (1.8 MB against 3.3 MB
// for Snappy), and a row group of 8192 makes reading one unit's bounds ~50 kB.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const URL_PMTILES =
  "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/pmtiles/huc.pmtiles";
const DEFAULT_OUT = new URL("../dist/hucindex.parquet", import.meta.url).pathname; // dist/ is ignored by git
const CONCURRENCY = 8;
const RETRIES = 4;

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i < 0 ? undefined : process.argv[i + 1];
};
const ZOOM = Number(argAfter("--zoom") ?? 8);
const CACHE = argAfter("--cache");
const OUT = argAfter("--out") ?? DEFAULT_OUT;
if (CACHE) mkdirSync(CACHE, { recursive: true });

async function fetchBytes(offset, length) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(URL_PMTILES, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await Bun.sleep(1000 * 2 ** attempt);
    }
  }
}

// ---- Protobuf ---------------------------------------------------------------

function varint(bytes, at) {
  let value = 0;
  let scale = 1;
  let byte;
  do {
    byte = bytes[at.i++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return value;
}

// fn(field, value), value being a number for varints, else the bytes.
function eachField(bytes, fn) {
  const at = { i: 0 };
  while (at.i < bytes.length) {
    const tag = varint(bytes, at);
    const wire = tag & 7;
    if (wire === 0) fn(tag >>> 3, varint(bytes, at));
    else if (wire === 1) at.i += 8;
    else if (wire === 5) at.i += 4;
    else if (wire === 2) {
      const length = varint(bytes, at);
      fn(tag >>> 3, bytes.subarray(at.i, at.i + length));
      at.i += length;
    } else throw new Error(`Unexpected protobuf wire type ${wire}`);
  }
}

function packedVarints(bytes) {
  const at = { i: 0 };
  const out = [];
  while (at.i < bytes.length) out.push(varint(bytes, at));
  return out;
}

// ---- PMTiles ----------------------------------------------------------------

function readDirectory(gzipped) {
  const bytes = gunzipSync(gzipped);
  const at = { i: 0 };
  const n = varint(bytes, at);
  const read = () => Array.from({ length: n }, () => varint(bytes, at));
  let id = 0;
  const ids = read().map((delta) => (id += delta));
  const runs = read();
  const lengths = read();
  const offsets = [];
  read().forEach((v, i) => offsets.push(v === 0 && i > 0 ? offsets[i - 1] + lengths[i - 1] : v - 1));
  return ids.map((tileId, i) => ({ tileId, run: runs[i], length: lengths[i], offset: offsets[i] }));
}

// Position along the zoom's Hilbert curve -> tile x, y.
function hilbertToXY(zoom, position) {
  let x = 0;
  let y = 0;
  let t = position;
  for (let s = 1; s < 2 ** zoom; s *= 2) {
    const rx = 1 & (t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

// Every stored tile of the zoom: { offset, length, tiles: [[x, y]] }, offset
// from the start of the tile data. A run is one blob used by several tiles.
async function zoomBlobs(zoom) {
  const header = await fetchBytes(0, 127);
  const view = new DataView(header.buffer, header.byteOffset);
  const u64 = (offset) => Number(view.getBigUint64(offset, true));
  if (header[7] !== 3) throw new Error("Expected PMTiles v3");
  const root = readDirectory(await fetchBytes(u64(8), u64(16)));
  const leaves = await fetchBytes(u64(40), u64(48));
  const entries = root.flatMap((e) =>
    e.run === 0 ? readDirectory(leaves.subarray(e.offset, e.offset + e.length)) : [e],
  );

  // Tile ids count up through the zooms: z has 4^z of them.
  const first = (4 ** zoom - 1) / 3;
  const last = first + 4 ** zoom;
  const blobs = [];
  for (const { tileId, run, length, offset } of entries) {
    const tiles = [];
    for (let id = Math.max(tileId, first); id < Math.min(tileId + run, last); id++) {
      tiles.push(hilbertToXY(zoom, id - first));
    }
    if (tiles.length) blobs.push({ offset, length, tiles });
  }
  return { dataOffset: u64(56), blobs };
}

async function blobBytes(dataOffset, { offset, length }) {
  const path = CACHE && `${CACHE}/${offset}-${length}.gz`;
  if (path && existsSync(path)) return readFileSync(path);
  const bytes = await fetchBytes(dataOffset + offset, length);
  if (path) writeFileSync(path, bytes);
  return bytes;
}

// ---- Vector tiles -----------------------------------------------------------

const decoder = new TextDecoder();
const units = new Map(); // code -> { name, pos: [min, max], neg: [min, max], south, north }

function newUnit(name) {
  return { name, pos: [Infinity, -Infinity], neg: [Infinity, -Infinity], south: Infinity, north: -Infinity };
}

function extendUnit(unit, lon, lat) {
  const wrapped = lon < -180 ? lon + 360 : lon > 180 ? lon - 360 : lon;
  const side = wrapped >= 0 ? unit.pos : unit.neg;
  if (wrapped < side[0]) side[0] = wrapped;
  if (wrapped > side[1]) side[1] = wrapped;
  if (lat < unit.south) unit.south = lat;
  if (lat > unit.north) unit.north = lat;
}

// Calls fn(x, y) for each vertex of a tile feature's geometry commands.
function eachVertex(commands, fn) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < commands.length; ) {
    const command = commands[i++];
    const id = command & 7;
    const count = command >>> 3;
    if (id === 7) continue; // ClosePath
    for (let k = 0; k < count; k++) {
      const dx = commands[i++];
      const dy = commands[i++];
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      fn(x, y);
    }
  }
}

function readLayer(bytes, zoom, tiles) {
  let layerName = "";
  let extent = 4096;
  const keys = [];
  const values = [];
  const features = [];
  eachField(bytes, (field, value) => {
    if (field === 1) layerName = decoder.decode(value);
    else if (field === 2) features.push(value);
    else if (field === 3) keys.push(decoder.decode(value));
    else if (field === 4) {
      let text = null; // only strings are wanted, but every value holds a place
      eachField(value, (f, bytes) => {
        if (f === 1) text = decoder.decode(bytes);
      });
      values.push(text);
    } else if (field === 5) extent = value;
  });
  if (!/^huc\d+$/.test(layerName)) return;

  const scale = 2 ** zoom;
  for (const feature of features) {
    let tags = [];
    let geometry = [];
    eachField(feature, (field, value) => {
      if (field === 2) tags = packedVarints(value);
      else if (field === 4) geometry = packedVarints(value);
    });
    const props = {};
    for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
    if (!props.huc) continue;
    let unit = units.get(props.huc);
    if (!unit) units.set(props.huc, (unit = newUnit(props.name ?? "")));
    for (const [tx, ty] of tiles) {
      eachVertex(geometry, (x, y) => {
        const lon = ((tx + x / extent) / scale) * 360 - 180;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + y / extent)) / scale))) * 180) / Math.PI;
        extendUnit(unit, lon, lat);
      });
    }
  }
}

// ---- Output -----------------------------------------------------------------

// The shorter way round: a unit on both sides of ±180 may straddle it.
function westEast({ pos, neg }) {
  if (pos[0] === Infinity) return neg;
  if (neg[0] === Infinity) return pos;
  return pos[1] - neg[0] <= neg[1] + 360 - pos[0] ? [neg[0], pos[1]] : [pos[0], neg[1] + 360];
}

// Some names repeat the code ("0204030108-Atlantic Ocean") or are only the code.
function cleanName(code, name) {
  const trimmed = name.replace(/[\t\r\n]+/g, " ").trim();
  if (trimmed === code) return "";
  return trimmed.startsWith(`${code}-`) ? trimmed.slice(code.length + 1) : trimmed;
}

const { dataOffset, blobs } = await zoomBlobs(ZOOM);
const totalMB = blobs.reduce((sum, b) => sum + b.length, 0) / 1e6;
console.log(`z${ZOOM}: ${blobs.length} tiles, ${totalMB.toFixed(1)} MB`);

let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < blobs.length) {
      const blob = blobs[next++];
      const tile = gunzipSync(await blobBytes(dataOffset, blob));
      eachField(tile, (field, layer) => {
        if (field === 3) readLayer(layer, ZOOM, blob.tiles);
      });
      if (++done % 100 === 0) console.log(`${done} / ${blobs.length}`);
    }
  }),
);

const lines = [...units.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([code, unit]) => {
    const [west, east] = westEast(unit);
    return [code, cleanName(code, unit.name), ...[west, unit.south, east, unit.north].map((v) => v.toFixed(3))].join("\t");
  });

const tmp = mkdtempSync(join(tmpdir(), "huc-index-"));
const tsv = join(tmp, "units.tsv");
writeFileSync(tsv, lines.join("\n") + "\n");
mkdirSync(dirname(OUT), { recursive: true });
const degrees = "'DECIMAL(6,3)'";
const sql = `COPY (
  SELECT huc, coalesce(name, '') AS name, west, south, east, north
  FROM read_csv('${tsv}', delim='\\t', header=false, quote='', escape='', columns={
    'huc': 'VARCHAR', 'name': 'VARCHAR', 'west': ${degrees}, 'south': ${degrees}, 'east': ${degrees}, 'north': ${degrees}
  })
  ORDER BY huc
) TO '${OUT}' (FORMAT parquet, COMPRESSION ZSTD, ROW_GROUP_SIZE 8192, PARQUET_VERSION V2)`;
const duckdb = Bun.spawnSync(["duckdb", "-c", sql], { stderr: "inherit" });
rmSync(tmp, { recursive: true });
if (duckdb.exitCode !== 0) throw new Error(`duckdb exited with ${duckdb.exitCode}`);

const counts = {};
for (const code of units.keys()) counts[code.length] = (counts[code.length] ?? 0) + 1;
console.log(`${lines.length} units ${JSON.stringify(counts)} -> ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB)`);
