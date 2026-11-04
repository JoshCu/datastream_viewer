#!/usr/bin/env bun
// Builds src/data/networkgages.json: which USGS sites sit on a reach of each
// routing network. Run with:
//   bun scripts/network-gages.js
//
// The browser only sees these tile by tile (the hydrofabric's gage tiles, the
// NWM tiles' `gages` attribute at z7+), which is no use for a CONUS-wide
// density, but the whole of each list is cheap to read here (~430 kB):
//
// NextGen: the hydrofabric's gages.pmtiles. It's built with tippecanoe -r1, so
//   z3 keeps every point, and the site numbers are in those four tiles' value
//   tables (hl_uri = "gages-<site>").
// NWM: the retrospective 3.0 chrtout.zarr's `gage_id`, RouteLink's gage column
//   as one 67 kB chunk of fixed-width strings, per COMID.
//
// Only all-digit ids are kept: the rest are Canadian stations, never in the
// USGS catalog.
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const GAGES_PMTILES =
  "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/pmtiles/gages.pmtiles";
const GAGE_ID_CHUNK =
  "https://noaa-nwm-retrospective-3-0-pds.s3.amazonaws.com/CONUS/zarr/chrtout.zarr/gage_id/0";
const GAGE_ID_WIDTH = 15; // dtype |S15
const OUT = new URL("../src/data/networkgages.json", import.meta.url).pathname;

const NEXTGEN = 1;
const NWM = 2;

async function fetchBytes(url, range) {
  const res = await fetch(url, range ? { headers: { Range: `bytes=${range[0]}-${range[1] - 1}` } } : {});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---- Protobuf / PMTiles, just what's needed ---------------------------------

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

// fn(field, bytes) for each length-delimited field of a message.
function eachField(bytes, fn) {
  const at = { i: 0 };
  while (at.i < bytes.length) {
    const tag = varint(bytes, at);
    const wire = tag & 7;
    if (wire === 0) varint(bytes, at);
    else if (wire === 1) at.i += 8;
    else if (wire === 5) at.i += 4;
    else if (wire === 2) {
      const length = varint(bytes, at);
      fn(tag >>> 3, bytes.subarray(at.i, at.i + length));
      at.i += length;
    } else throw new Error(`Unexpected protobuf wire type ${wire}`);
  }
}

// The byte ranges of a zoom's tiles. This archive has no leaf directories.
async function pmtilesZoomRanges(url, zoom) {
  const header = await fetchBytes(url, [0, 127]);
  const view = new DataView(header.buffer);
  const u64 = (offset) => Number(view.getBigUint64(offset, true));
  if (header[7] !== 3) throw new Error("Expected PMTiles v3");
  if (u64(48) !== 0) throw new Error("Expected no leaf directories");
  const rootOffset = u64(8);
  const dataOffset = u64(56);
  const at = { i: 0 };
  const root = gunzipSync(await fetchBytes(url, [rootOffset, rootOffset + u64(16)]));
  const n = varint(root, at);
  const read = () => Array.from({ length: n }, () => varint(root, at));
  let id = 0;
  const ids = read().map((delta) => (id += delta));
  read(); // run lengths
  const lengths = read();
  const offsets = [];
  read().forEach((v, i) => offsets.push(v === 0 && i > 0 ? offsets[i - 1] + lengths[i - 1] : v - 1));

  // Tile ids count up through the zooms: z has 4^z of them.
  const first = (4 ** zoom - 1) / 3;
  const last = first + 4 ** zoom;
  return ids.flatMap((tileId, i) =>
    tileId >= first && tileId < last
      ? [[dataOffset + offsets[i], dataOffset + offsets[i] + lengths[i]]]
      : [],
  );
}

// ---- The two networks -------------------------------------------------------

async function nextgenSites() {
  const sites = new Set();
  const decoder = new TextDecoder();
  for (const range of await pmtilesZoomRanges(GAGES_PMTILES, 3)) {
    const tile = gunzipSync(await fetchBytes(GAGES_PMTILES, range));
    eachField(tile, (field, layer) => {
      if (field !== 3) return; // Tile.layers
      eachField(layer, (field, value) => {
        if (field !== 4) return; // Layer.values
        eachField(value, (field, text) => {
          if (field !== 1) return; // Value.string_value
          const uri = decoder.decode(text);
          if (uri.startsWith("gages-")) sites.add(uri.slice(6));
        });
      });
    });
  }
  return sites;
}

async function nwmSites() {
  const raw = Bun.zstdDecompressSync(await fetchBytes(GAGE_ID_CHUNK));
  const decoder = new TextDecoder("latin1");
  const sites = new Set();
  for (let i = 0; i < raw.length; i += GAGE_ID_WIDTH) {
    const id = decoder.decode(raw.subarray(i, i + GAGE_ID_WIDTH)).replace(/\0/g, "").trim();
    if (id) sites.add(id);
  }
  return sites;
}

const nextgen = await nextgenSites();
const nwm = await nwmSites();
const sites = {};
for (const no of [...new Set([...nextgen, ...nwm])].sort()) {
  if (!/^\d+$/.test(no)) continue;
  sites[no] = (nextgen.has(no) ? NEXTGEN : 0) | (nwm.has(no) ? NWM : 0);
}
const out = {
  note: "Bits: 1 = on a NextGen flowpath (gages.pmtiles), 2 = on an NWM reach (retrospective 3.0 gage_id). Built by scripts/network-gages.js.",
  builtAt: new Date().toISOString().slice(0, 10),
  sites,
};
writeFileSync(OUT, JSON.stringify(out) + "\n");
const count = (bit) => Object.values(sites).filter((v) => v & bit).length;
console.log(`${count(NEXTGEN)} NextGen, ${count(NWM)} NWM, ${count(3)} either -> ${OUT}`);
