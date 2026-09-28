// ====================================================================
// HDF5 byte-layout reader for ngen forcing files (worker-side, pure).
//
// Walks just enough HDF5 metadata, over async range reads, to find where each
// 2-D variable's bytes live and what the catchment ids are — so rows can then
// be fetched with plain HTTP Range requests instead of downloading the file.
// It is deliberately a subset of HDF5, the subset the datastream forcing
// writer produces:
//
//   superblock v2/v3 → root object header (v1 or v2 headers, with
//   continuations) → links, either compact (Link messages) or dense (Link
//   Info → fractal heap + name-index v2 B-tree) → each dataset's dataspace,
//   datatype, contiguous layout and filter pipeline → the `ids` variable's
//   variable-length strings from the global heap.
//
// Anything outside that subset throws an "unsupported" error rather than
// guessing, and the caller falls back to downloading the whole file.
//
// `read(offset, length)` must resolve to a Uint8Array of exactly `length`
// bytes; createBlockReader() adapts a byte-range fetcher to that.
// ====================================================================

const ID_VAR = "ids";

// ---- Range-backed reader --------------------------------------------

// HDF5 metadata is small and scattered (the dataset headers sit just before
// each variable's data block), so small reads go through a cache of
// `blockSize` blocks while reads at least that big are fetched exactly.
// `fetchRange(start, endInclusive)` resolves to an ArrayBuffer. Concurrent
// reads of the same block share one request.
export function createBlockReader(fetchRange, { blockSize = 32 * 1024 } = {}) {
  const blocks = new Map(); // block index -> Promise<Uint8Array>
  let requests = 0;
  let bytes = 0;

  const fetchBytes = async (start, end) => {
    requests++;
    const buf = new Uint8Array(await fetchRange(start, end));
    bytes += buf.length;
    return buf;
  };

  const block = (i) => {
    let p = blocks.get(i);
    if (!p) {
      p = fetchBytes(i * blockSize, (i + 1) * blockSize - 1);
      blocks.set(i, p);
    }
    return p;
  };

  // Fetch [offset, offset + length) as one request and keep every whole block
  // it covers. HDF5 metadata is reached by a chain of dependent reads, each a
  // round trip; priming the region it clusters in turns most of that chain
  // into cache hits. A file shorter than the range just primes what exists.
  async function prime(offset, length) {
    const end = offset + length;
    // Skip a leading stretch that's already cached (an earlier prime).
    let i = Math.floor(offset / blockSize);
    while (blocks.has(i) && i * blockSize < end) i++;
    const start = Math.max(offset, i * blockSize);
    if (start >= end) return;
    const buf = await fetchBytes(start, end - 1);
    for (let b = Math.ceil(start / blockSize); (b + 1) * blockSize <= start + buf.length; b++) {
      const from = b * blockSize - start;
      if (!blocks.has(b)) blocks.set(b, Promise.resolve(buf.subarray(from, from + blockSize)));
    }
  }

  async function read(offset, length) {
    const first = Math.floor(offset / blockSize);
    const last = Math.floor((offset + length - 1) / blockSize);
    // A big read is fetched exactly — unless priming already holds all of it.
    let cached = true;
    for (let i = first; i <= last && cached; i++) cached = blocks.has(i);
    if (length >= blockSize && !cached) {
      const buf = await fetchBytes(offset, offset + length - 1);
      if (buf.length < length) throw new Error("HDF5: read past end of file");
      return buf;
    }
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(block(i));
    const loaded = await Promise.all(parts);
    const out = new Uint8Array(length);
    let written = 0;
    for (let k = 0; k < loaded.length; k++) {
      const b = loaded[k];
      const from = k === 0 ? offset - first * blockSize : 0;
      const take = Math.min(b.length - from, length - written);
      if (take <= 0) break;
      out.set(b.subarray(from, from + take), written);
      written += take;
    }
    if (written < length) throw new Error("HDF5: read past end of file");
    return out;
  }

  return { read, prime, stats: () => ({ requests, bytes }) };
}

// ---- Little-endian cursor -------------------------------------------

const UNDEFINED = -1; // an all-ones address ("undefined address")

class Cursor {
  constructor(bytes, pos = 0) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = pos;
  }
  u8() {
    return this.v.getUint8(this.p++);
  }
  u16() {
    const x = this.v.getUint16(this.p, true);
    this.p += 2;
    return x;
  }
  u32() {
    const x = this.v.getUint32(this.p, true);
    this.p += 4;
    return x;
  }
  // Unsigned little-endian integer of `n` bytes (n <= 8). Values above 2^53
  // can't occur in a real file offset; an all-ones value is UNDEFINED.
  uint(n) {
    let x = 0;
    let allOnes = true;
    for (let i = 0; i < n; i++) {
      const byte = this.v.getUint8(this.p + i);
      if (byte !== 0xff) allOnes = false;
      x += byte * 2 ** (8 * i);
    }
    this.p += n;
    return allOnes && n > 1 ? UNDEFINED : x;
  }
  skip(n) {
    this.p += n;
  }
  bytes(n) {
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  sig(expected) {
    const s = String.fromCharCode(...this.bytes(4));
    if (s !== expected) {
      throw new Error(`HDF5: expected ${expected} signature, found ${JSON.stringify(s)}`);
    }
  }
}

function unsupported(what) {
  return new Error(`HDF5 layout unsupported: ${what}`);
}

// ---- Superblock -------------------------------------------------------

async function readSuperblock(read) {
  const c = new Cursor(await read(0, 48));
  const sig = c.bytes(8);
  const HDF5_SIG = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!HDF5_SIG.every((b, i) => sig[i] === b)) {
    // A userblock would put the superblock at 512, 1024, ...; netCDF-4 files
    // don't have one.
    throw new Error("Not an HDF5 file (no superblock at offset 0)");
  }
  const version = c.u8();
  if (version !== 2 && version !== 3) throw unsupported(`superblock v${version}`);
  const O = c.u8();
  const L = c.u8();
  c.skip(1); // consistency flags
  const ctx = { O, L };
  const base = c.uint(O);
  if (base !== 0) throw unsupported("non-zero base address");
  c.uint(O); // superblock extension
  ctx.eof = c.uint(O);
  ctx.root = c.uint(O);
  return ctx;
}

// ---- Object headers ---------------------------------------------------

const MSG = {
  NIL: 0x00,
  DATASPACE: 0x01,
  LINK_INFO: 0x02,
  DATATYPE: 0x03,
  LINK: 0x06,
  LAYOUT: 0x08,
  FILTERS: 0x0b,
  CONTINUATION: 0x10,
};

// Every message of an object header (following continuation blocks), as
// { type, data: Uint8Array }.
async function readObjectHeader(read, ctx, addr) {
  const head = await read(addr, 16);
  if (head[0] === 0x4f && head[1] === 0x48 && head[2] === 0x44 && head[3] === 0x52) {
    return readHeaderV2(read, ctx, addr);
  }
  if (head[0] === 1) return readHeaderV1(read, ctx, addr, head);
  throw unsupported(`object header at ${addr}`);
}

async function readHeaderV2(read, ctx, addr) {
  const pre = new Cursor(await read(addr, 6 + 16 + 4 + 8));
  pre.sig("OHDR");
  if (pre.u8() !== 2) throw unsupported("object header version");
  const flags = pre.u8();
  if (flags & 0x20) pre.skip(16); // times
  if (flags & 0x10) pre.skip(4); // attribute phase change
  const sizeBytes = 1 << (flags & 0x03);
  const chunkSize = pre.uint(sizeBytes);
  const start = addr + pre.p;
  const messages = [];
  const pending = [{ addr: start, len: chunkSize, signed: false }];
  while (pending.length) {
    const blk = pending.shift();
    let bytes = await read(blk.addr, blk.len);
    let c = new Cursor(bytes);
    if (blk.signed) {
      c.sig("OCHK");
      // The block ends in a checksum; its messages fill the rest.
      bytes = bytes.subarray(0, bytes.length - 4);
      c = new Cursor(bytes, 4);
    }
    const headerLen = 4 + (flags & 0x04 ? 2 : 0);
    while (c.p + headerLen <= bytes.length) {
      const type = c.u8();
      const size = c.u16();
      c.skip(1); // message flags
      if (flags & 0x04) c.skip(2); // creation order
      if (c.p + size > bytes.length) break;
      const data = c.bytes(size);
      if (type === MSG.CONTINUATION) {
        const cc = new Cursor(data);
        pending.push({ addr: cc.uint(ctx.O), len: cc.uint(ctx.L), signed: true });
      } else if (type !== MSG.NIL) {
        messages.push({ type, data });
      }
    }
  }
  return messages;
}

async function readHeaderV1(read, ctx, addr, head) {
  const h = new Cursor(head);
  h.skip(2); // version, reserved
  const count = h.u16();
  h.skip(4); // reference count
  const size = h.u32();
  const messages = [];
  // The v1 prefix is 12 bytes, padded to 16.
  const pending = [{ addr: addr + 16, len: size }];
  while (pending.length && messages.length < count) {
    const blk = pending.shift();
    const bytes = await read(blk.addr, blk.len);
    const c = new Cursor(bytes);
    while (c.p + 8 <= bytes.length) {
      const type = c.u16();
      const msgSize = c.u16();
      c.skip(4); // flags + reserved
      if (c.p + msgSize > bytes.length) break;
      const data = c.bytes(msgSize);
      if (type === MSG.CONTINUATION) {
        const cc = new Cursor(data);
        pending.push({ addr: cc.uint(ctx.O), len: cc.uint(ctx.L) });
      } else if (type !== MSG.NIL) {
        messages.push({ type, data });
      }
    }
  }
  return messages;
}

// ---- Links ------------------------------------------------------------

// Parse one Link message; returns { name, addr } for a hard link, else null.
function parseLink(bytes, ctx) {
  const c = new Cursor(bytes);
  if (c.u8() !== 1) throw unsupported("link message version");
  const flags = c.u8();
  const linkType = flags & 0x08 ? c.u8() : 0;
  if (flags & 0x04) c.skip(8); // creation order
  if (flags & 0x10) c.skip(1); // name charset
  const nameLen = c.uint(1 << (flags & 0x03));
  const name = new TextDecoder().decode(c.bytes(nameLen));
  if (linkType !== 0) return null; // soft/external links aren't datasets here
  return { name, addr: c.uint(ctx.O) };
}

async function groupLinks(read, ctx, messages) {
  const links = [];
  for (const m of messages) {
    if (m.type === MSG.LINK) {
      const link = parseLink(m.data, ctx);
      if (link) links.push(link);
    }
  }
  const info = messages.find((m) => m.type === MSG.LINK_INFO);
  if (!info) return links;
  const c = new Cursor(info.data);
  c.skip(1); // version
  const flags = c.u8();
  if (flags & 0x01) c.skip(8); // max creation index
  const heapAddr = c.uint(ctx.O);
  const nameIndexAddr = c.uint(ctx.O);
  if (heapAddr === UNDEFINED) return links; // compact storage after all
  const heap = await readFractalHeap(read, ctx, heapAddr);
  const heapIds = await readNameIndex(read, ctx, nameIndexAddr, heap.idLen);
  const linkBytes = await Promise.all(heapIds.map((id) => heapObject(read, ctx, heap, id)));
  for (const bytes of linkBytes) {
    const link = parseLink(bytes, ctx);
    if (link) links.push(link);
  }
  return links;
}

// Fractal heap header: just what's needed to locate managed objects.
async function readFractalHeap(read, ctx, addr) {
  const { O, L } = ctx;
  const c = new Cursor(await read(addr, 4 + 1 + 2 + 2 + 1 + 4 + 12 * 8 + 2 + 8 + 8 + 2 + 2 + 8 + 2));
  c.sig("FRHP");
  c.skip(1); // version
  const idLen = c.u16();
  const filterLen = c.u16();
  if (filterLen) throw unsupported("filtered fractal heap");
  c.skip(1); // flags
  const maxManaged = c.u32();
  c.uint(L); // next huge id
  c.uint(O); // huge-object B-tree
  c.uint(L); // free space
  c.uint(O); // free-space manager
  c.uint(L); // managed space
  c.uint(L); // allocated managed space
  c.uint(L); // direct block allocation iterator
  c.uint(L); // managed object count
  c.uint(L); // huge object size
  c.uint(L); // huge object count
  c.uint(L); // tiny object size
  c.uint(L); // tiny object count
  const width = c.u16();
  const startSize = c.uint(L);
  const maxDirect = c.uint(L);
  const maxHeapBits = c.u16();
  c.u16(); // starting rows in root indirect block
  const root = c.uint(O);
  const rootRows = c.u16();
  const log2 = (x) => Math.round(Math.log2(x));
  return {
    addr,
    idLen,
    width,
    startSize,
    maxDirect,
    root,
    rootRows,
    offBytes: Math.ceil(maxHeapBits / 8),
    lenBytes: Math.min(
      Math.ceil(log2(maxDirect) / 8),
      Math.floor(log2(maxManaged) / 8) + 1,
    ),
    maxDirectRows: log2(maxDirect) - log2(startSize) + 2,
  };
}

// Size of the direct blocks in doubling-table row `r`.
function rowBlockSize(heap, r) {
  return r === 0 ? heap.startSize : heap.startSize * 2 ** (r - 1);
}

// Bytes of one managed heap object, located from its heap id.
async function heapObject(read, ctx, heap, id) {
  const c = new Cursor(id);
  const kind = (c.u8() >> 4) & 0x03;
  if (kind !== 0) throw unsupported("huge/tiny fractal heap object");
  const offset = c.uint(heap.offBytes);
  const length = c.uint(heap.lenBytes);

  if (heap.rootRows === 0) {
    // The root is a single direct block covering heap offsets from 0; an
    // object's heap offset is its byte offset from the block's start.
    return read(heap.root + offset, length);
  }

  // Root indirect block whose entries are direct blocks (a group would need
  // tens of thousands of links before it nested a second indirect level).
  let r = 0;
  let rowStart = 0;
  while (rowStart + heap.width * rowBlockSize(heap, r) <= offset) {
    rowStart += heap.width * rowBlockSize(heap, r);
    r++;
  }
  if (r >= heap.maxDirectRows || r >= heap.rootRows) {
    throw unsupported("nested fractal heap indirect blocks");
  }
  const size = rowBlockSize(heap, r);
  const col = Math.floor((offset - rowStart) / size);
  const entry = r * heap.width + col;
  const ib = heap.root + 4 + 1 + ctx.O + heap.offBytes + entry * ctx.O;
  const blockAddr = new Cursor(await read(ib, ctx.O)).uint(ctx.O);
  const blockOffset = rowStart + col * size;
  return read(blockAddr + (offset - blockOffset), length);
}

// Heap ids of every link, from the group's name-index v2 B-tree (records are
// a 4-byte name hash followed by the heap id).
async function readNameIndex(read, ctx, addr, idLen) {
  const c = new Cursor(await read(addr, 4 + 2 + 4 + 2 + 2 + 2 + ctx.O + 2 + ctx.L + 4));
  c.sig("BTHD");
  c.skip(1); // version
  const type = c.u8();
  if (type !== 5) throw unsupported(`name index B-tree type ${type}`);
  c.u32(); // node size
  const recordSize = c.u16();
  const depth = c.u16();
  c.skip(2); // split / merge percent
  const root = c.uint(ctx.O);
  const count = c.u16();
  if (depth !== 0) throw unsupported("multi-level link B-tree");
  const leaf = new Cursor(await read(root, 6 + count * recordSize));
  leaf.sig("BTLF");
  leaf.skip(2); // version, type
  const ids = [];
  for (let i = 0; i < count; i++) {
    const rec = leaf.bytes(recordSize);
    ids.push(rec.subarray(4, 4 + idLen));
  }
  return ids;
}

// ---- Datasets ---------------------------------------------------------

function parseDataspace(bytes, ctx) {
  const c = new Cursor(bytes);
  const version = c.u8();
  const rank = c.u8();
  c.skip(1); // flags
  if (version === 1) c.skip(5);
  else if (version === 2) {
    if (c.u8() === 2) return []; // null dataspace
  } else throw unsupported(`dataspace v${version}`);
  const shape = [];
  for (let i = 0; i < rank; i++) shape.push(c.uint(ctx.L));
  return shape;
}

// numpy-style dtype string, "vlen-str", or null for anything else.
function parseDatatype(bytes) {
  const c = new Cursor(bytes);
  const b0 = c.u8();
  const cls = b0 & 0x0f;
  const bits0 = c.u8();
  c.skip(2);
  const size = c.u32();
  const order = bits0 & 0x01 ? ">" : "<";
  if (cls === 1) return `${order}f${size}`;
  if (cls === 0) return `${order}${bits0 & 0x08 ? "i" : "u"}${size}`;
  if (cls === 9 && (bits0 & 0x0f) === 1) return "vlen-str";
  return null;
}

// { addr, size } of a contiguous layout, null for chunked/compact storage.
function parseLayout(bytes, ctx) {
  const c = new Cursor(bytes);
  const version = c.u8();
  if (version >= 3) {
    if (c.u8() !== 1) return null;
    return { addr: c.uint(ctx.O), size: c.uint(ctx.L) };
  }
  // v1/v2: rank, class, reserved, then the address for contiguous/chunked.
  c.skip(1);
  if (c.u8() !== 1) return null;
  c.skip(5);
  return { addr: c.uint(ctx.O), size: null };
}

function filterCount(bytes) {
  return new Cursor(bytes, 1).u8();
}

async function readDataset(read, ctx, addr) {
  const messages = await readObjectHeader(read, ctx, addr);
  const find = (t) => messages.find((m) => m.type === t);
  const space = find(MSG.DATASPACE);
  const type = find(MSG.DATATYPE);
  const layout = find(MSG.LAYOUT);
  if (!space || !type || !layout) return null; // not a dataset
  const filters = find(MSG.FILTERS);
  return {
    shape: parseDataspace(space.data, ctx),
    dtype: parseDatatype(type.data),
    layout: parseLayout(layout.data, ctx),
    filtered: !!filters && filterCount(filters.data) > 0,
  };
}

// ---- Variable-length strings (global heap) ----------------------------

async function readVlenStrings(read, ctx, addr, count) {
  const recSize = 4 + ctx.O + 4;
  const raw = new Cursor(await read(addr, count * recSize));
  const refs = new Array(count);
  const collections = new Set();
  for (let i = 0; i < count; i++) {
    const len = raw.u32();
    const coll = raw.uint(ctx.O);
    const index = raw.u32();
    refs[i] = { len, coll, index };
    collections.add(coll);
  }

  const heaps = new Map(); // collection addr -> Map(index -> bytes)
  await Promise.all(
    [...collections].map(async (coll) => {
      const head = new Cursor(await read(coll, 8 + ctx.L));
      head.sig("GCOL");
      head.skip(4); // version + reserved
      const size = head.uint(ctx.L);
      const c = new Cursor(await read(coll, size), 8 + ctx.L);
      const objects = new Map();
      while (c.p + 8 + ctx.L <= size) {
        const index = c.u16();
        if (index === 0) break; // free space runs to the end
        c.skip(6); // reference count + reserved
        const objSize = c.uint(ctx.L);
        objects.set(index, c.bytes(objSize));
        c.skip((8 - (objSize % 8)) % 8);
      }
      heaps.set(coll, objects);
    }),
  );

  const decoder = new TextDecoder();
  return refs.map(({ len, coll, index }) => {
    const bytes = heaps.get(coll)?.get(index);
    if (!bytes) throw new Error(`HDF5: missing global heap object ${coll}:${index}`);
    return decoder.decode(bytes.subarray(0, len));
  });
}

// ---- Entry point --------------------------------------------------------

// Layout of a forcing file: the ordered catchment ids and, for every 2-D
// variable with one row per catchment that is stored contiguously and
// unfiltered, its byte offset, shape and dtype (the same shape as
// fetch_forcings.py's scan_metadata()). Variables that fail those checks are
// listed in `skipped` rather than silently trusted.
//
// `prime(offset, length)` (optional, see createBlockReader) lets the reader
// fetch the id strings' region in one request once it knows where it ends.
export async function readForcingLayout(read, { prime } = {}) {
  const ctx = await readSuperblock(read);
  const rootHeader = await readObjectHeader(read, ctx, ctx.root);
  const links = await groupLinks(read, ctx, rootHeader);

  const datasets = await Promise.all(
    links.map(async (l) => ({ name: l.name, ds: await readDataset(read, ctx, l.addr) })),
  );
  const idEntry = datasets.find((d) => d.name === ID_VAR);
  if (!idEntry?.ds) throw new Error(`Forcing file has no "${ID_VAR}" variable`);
  const idDs = idEntry.ds;
  if (idDs.dtype !== "vlen-str" || !idDs.layout || idDs.layout.addr === UNDEFINED) {
    throw unsupported(`"${ID_VAR}" is not a contiguous string array`);
  }
  const ncat = idDs.shape[0];
  // The id pointers and the global heap holding the strings sit between the
  // ids variable and the first data block: fetch that span in one go rather
  // than collection by collection.
  const dataStarts = datasets
    .filter((d) => d.ds?.layout && d.ds.layout.addr !== UNDEFINED && d.ds.layout.addr > idDs.layout.addr)
    .map((d) => d.ds.layout.addr);
  if (prime && dataStarts.length) {
    await prime(idDs.layout.addr, Math.min(...dataStarts) - idDs.layout.addr);
  }
  const ids = await readVlenStrings(read, ctx, idDs.layout.addr, ncat);

  const variables = {};
  const skipped = [];
  for (const { name, ds } of datasets) {
    if (!ds || name === ID_VAR) continue;
    const usable =
      ds.layout &&
      ds.layout.addr !== UNDEFINED &&
      !ds.filtered &&
      /^[<>][fiu]\d$/.test(ds.dtype ?? "") &&
      ds.shape.length === 2 &&
      ds.shape[0] === ncat;
    if (usable) {
      variables[name] = { offset: ds.layout.addr, shape: ds.shape, dtype: ds.dtype };
    } else if (ds.shape.length === 2) {
      skipped.push(name);
    }
  }
  return { ids, variables, skipped };
}
