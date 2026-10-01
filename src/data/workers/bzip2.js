// ====================================================================
// Minimal bzip2 decoder (pure, worker-side).
//
// NEXRAD Level II files are a series of independent bzip2 streams (one per
// LDM record), and no browser ships a bzip2 DecompressionStream, so this is a
// small from-scratch decoder: Huffman → MTF/RLE2 → inverse BWT → RLE1. CRCs
// are not checked; a corrupt stream throws or yields garbage radials, which
// the Level II parser bounds-checks anyway.
// ====================================================================

const BLOCK_MAGIC_HI = 0x314159;
const BLOCK_MAGIC_LO = 0x265359;
const EOS_MAGIC_HI = 0x177245;
const EOS_MAGIC_LO = 0x385090;
const GROUP_SIZE = 50;
const MAX_CODE_LEN = 20;

// MSB-first bit reader over a byte array.
function bitReader(bytes, start) {
  let pos = start;
  let buf = 0;
  let count = 0;
  const fill = () => {
    while (count <= 24) {
      buf = ((buf << 8) | (pos < bytes.length ? bytes[pos] : 0)) >>> 0;
      pos++;
      count += 8;
    }
  };
  return {
    // n ≤ 24
    peek(n) {
      if (count < n) fill();
      return (buf >>> (count - n)) & ((1 << n) - 1);
    },
    skip(n) {
      count -= n;
    },
    read(n) {
      if (count < n) fill();
      count -= n;
      return (buf >>> count) & ((1 << n) - 1);
    },
    bit() {
      if (count < 1) fill();
      count -= 1;
      return (buf >>> count) & 1;
    },
    // Drop to the next byte boundary; returns the byte offset reached.
    alignedPos() {
      return pos - (count >> 3);
    },
  };
}

// Canonical Huffman table: limit/base per code length, symbols sorted by length.
function huffmanTable(lengths, alphaSize) {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] < minLen) minLen = lengths[i];
  }
  const perm = new Int32Array(alphaSize);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let s = 0; s < alphaSize; s++) if (lengths[s] === len) perm[pp++] = s;
  }
  const limit = new Int32Array(MAX_CODE_LEN + 2).fill(-1);
  const base = new Int32Array(MAX_CODE_LEN + 2);
  let code = 0;
  let idx = 0;
  for (let len = minLen; len <= maxLen; len++) {
    let n = 0;
    for (let s = 0; s < alphaSize; s++) if (lengths[s] === len) n++;
    base[len] = idx - code; // perm index = code + base[len]
    code += n;
    idx += n;
    limit[len] = code - 1;
    code <<= 1;
  }
  return { minLen, maxLen, limit, base, perm };
}

function decodeSymbol(br, t) {
  const bits = br.peek(t.maxLen);
  for (let len = t.minLen; len <= t.maxLen; len++) {
    const code = bits >>> (t.maxLen - len);
    if (code <= t.limit[len]) {
      br.skip(len);
      return t.perm[code + t.base[len]];
    }
  }
  throw new Error("bzip2: bad Huffman code");
}

// Decode one block into `tt` (byte values in the low 8 bits); returns the
// block length and origPtr.
function readBlock(br, tt) {
  br.read(16); // block CRC (unchecked)
  br.read(16);
  if (br.bit()) throw new Error("bzip2: randomized blocks unsupported");
  const origPtr = br.read(24);

  const seqToUnseq = new Uint8Array(256);
  let nInUse = 0;
  const used16 = br.read(16);
  for (let i = 0; i < 16; i++) {
    if (!(used16 & (0x8000 >> i))) continue;
    const bits = br.read(16);
    for (let j = 0; j < 16; j++) {
      if (bits & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
    }
  }
  if (!nInUse) throw new Error("bzip2: empty symbol map");
  const alphaSize = nInUse + 2;

  const nGroups = br.read(3);
  if (nGroups < 2 || nGroups > 6) throw new Error("bzip2: bad group count");
  const nSelectors = br.read(15);
  if (!nSelectors) throw new Error("bzip2: no selectors");
  const groupMtf = [0, 1, 2, 3, 4, 5].slice(0, nGroups);
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.bit()) if (++j >= nGroups) throw new Error("bzip2: bad selector");
    const v = groupMtf[j];
    groupMtf.splice(j, 1);
    groupMtf.unshift(v);
    selectors[i] = v;
  }

  const tables = [];
  const lengths = new Uint8Array(alphaSize);
  for (let g = 0; g < nGroups; g++) {
    let len = br.read(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (len < 1 || len > MAX_CODE_LEN) throw new Error("bzip2: bad code length");
        if (!br.bit()) break;
        len += br.bit() ? -1 : 1;
      }
      lengths[s] = len;
    }
    tables.push(huffmanTable(lengths, alphaSize));
  }

  // Huffman → RUNA/RUNB zero-runs + MTF → bytes.
  const mtf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) mtf[i] = i;
  const eob = alphaSize - 1;
  let n = 0;
  let sel = 0;
  let left = 0;
  let table = null;
  let run = 0;
  let runBit = 1;
  for (;;) {
    if (left === 0) {
      if (sel >= nSelectors) throw new Error("bzip2: ran out of selectors");
      table = tables[selectors[sel++]];
      left = GROUP_SIZE;
    }
    left--;
    const sym = decodeSymbol(br, table);
    if (sym <= 1) {
      run += runBit << sym; // RUNA adds 1×, RUNB 2× the current place value
      runBit <<= 1;
      continue;
    }
    if (run) {
      if (n + run > tt.length) throw new Error("bzip2: block overflow");
      const b = seqToUnseq[mtf[0]];
      tt.fill(b, n, n + run);
      n += run;
      run = 0;
      runBit = 1;
    }
    if (sym === eob) break;
    if (n >= tt.length) throw new Error("bzip2: block overflow");
    const k = sym - 1;
    const v = mtf[k];
    mtf.copyWithin(1, 0, k);
    mtf[0] = v;
    tt[n++] = seqToUnseq[v];
  }
  if (origPtr >= n) throw new Error("bzip2: bad origPtr");
  return { n, origPtr };
}

// Growable output buffer.
function output(initial) {
  let buf = new Uint8Array(initial);
  let len = 0;
  return {
    ensure(extra) {
      if (len + extra <= buf.length) return;
      let size = buf.length * 2;
      while (size < len + extra) size *= 2;
      const next = new Uint8Array(size);
      next.set(buf.subarray(0, len));
      buf = next;
    },
    push(b) {
      buf[len++] = b;
    },
    get buf() {
      return buf;
    },
    get len() {
      return len;
    },
    set len(v) {
      len = v;
    },
    result() {
      return buf.subarray(0, len);
    },
  };
}

// Inverse BWT + RLE1 of one decoded block, appended to `out`.
function emitBlock(tt, n, origPtr, out) {
  const counts = new Int32Array(256);
  for (let i = 0; i < n; i++) counts[tt[i] & 0xff]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i];
    counts[i] = sum;
    sum += c;
  }
  for (let i = 0; i < n; i++) {
    const b = tt[i] & 0xff;
    tt[counts[b]++] |= i << 8;
  }

  // RLE1 can expand each 5-byte group to 259 bytes; reserve generously and
  // grow on demand.
  out.ensure(n * 2);
  let pos = tt[origPtr] >>> 8;
  let last = -1;
  let same = 0;
  for (let i = 0; i < n; i++) {
    const v = tt[pos];
    const b = v & 0xff;
    pos = v >>> 8;
    if (same === 4) {
      out.ensure(b);
      const buf = out.buf;
      let len = out.len;
      for (let k = 0; k < b; k++) buf[len++] = last;
      out.len = len;
      same = 0;
      last = -1;
      continue;
    }
    if (b === last) same++;
    else {
      last = b;
      same = 1;
    }
    out.ensure(1);
    out.push(b);
  }
}

// Decode a bzip2 stream (or several concatenated) starting at bytes[start].
// Returns { data, end } where end is the byte offset just past the last stream.
export function bunzip2(bytes, start = 0) {
  const out = output(Math.max(1 << 16, (bytes.length - start) * 4));
  let offset = start;
  let tt = null;
  while (
    offset + 4 <= bytes.length &&
    bytes[offset] === 0x42 && bytes[offset + 1] === 0x5a && bytes[offset + 2] === 0x68
  ) {
    const level = bytes[offset + 3] - 0x30;
    if (level < 1 || level > 9) throw new Error("bzip2: bad block size");
    if (!tt || tt.length < level * 100000) tt = new Uint32Array(level * 100000);
    const br = bitReader(bytes, offset + 4);
    for (;;) {
      const hi = br.read(24);
      const lo = br.read(24);
      if (hi === EOS_MAGIC_HI && lo === EOS_MAGIC_LO) {
        br.read(16); // stream CRC
        br.read(16);
        break;
      }
      if (hi !== BLOCK_MAGIC_HI || lo !== BLOCK_MAGIC_LO) {
        throw new Error("bzip2: bad block magic");
      }
      const { n, origPtr } = readBlock(br, tt);
      emitBlock(tt, n, origPtr, out);
    }
    offset = br.alignedPos();
  }
  return { data: out.result(), end: offset };
}
