// ====================================================================
// NWM retrospective (chrtout.zarr) reads (worker-side, pure).
//
// A chunk is 672 hours × 30,000 reaches of int32, time-major and
// zstd-compressed (~1–4 MB, 80.6 MB decoded). One reach over a window is
// one chunk per 28 days: fetch them, decode each in turn and keep the
// reach's column. The zstd decoder (zstddec, wasm) is passed in by
// parse.worker.js, which owns the CDN import.
// ====================================================================
import {
  NWM_FILL,
  NWM_SCALE,
  RETRO_BASE,
  RETRO_CHUNK_F,
  RETRO_CHUNK_T,
  RETRO_FETCH_CONCURRENCY,
  RETRO_N_TIMES,
  RETRO_T0_MS,
} from "../../config.js";

const HOUR_MS = 3600 * 1000;
const CHUNK_BYTES = RETRO_CHUNK_T * RETRO_CHUNK_F * 4;

async function fetchChunk(name, t, f) {
  const url = `${RETRO_BASE}/${name}/${t}.${f}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      // A chunk zarr never wrote is all fill.
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`retrospective chunk ${t}.${f}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
}

// One reach's series. `name` is the zarr array, `col` the reach's column
// (its operational file row), [h0, h1] the hour indexes (inclusive, clamped
// to the record). Returns { times: Float64Array (epoch ms), values:
// Float32Array (NaN for fill), bytes, chunks }.
export async function readRetroSeries({ name, col, h0, h1 }, zstd) {
  h0 = Math.max(0, Math.floor(h0));
  h1 = Math.min(RETRO_N_TIMES - 1, Math.floor(h1));
  if (h1 < h0) throw new Error("Window is outside the retrospective (1979-02-01 to 2023-02-01)");
  const f = Math.floor(col / RETRO_CHUNK_F);
  const c = col - f * RETRO_CHUNK_F;
  const t0 = Math.floor(h0 / RETRO_CHUNK_T);
  const t1 = Math.floor(h1 / RETRO_CHUNK_T);

  const n = h1 - h0 + 1;
  const times = new Float64Array(n);
  const values = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) times[i] = RETRO_T0_MS + (h0 + i) * HOUR_MS;

  let bytes = 0;
  let next = t0;
  // Fetch RETRO_FETCH_CONCURRENCY chunks ahead; decode as each lands (one
  // 80 MB decode at a time, so the wasm heap stays one chunk big).
  let decoding = Promise.resolve();
  const worker = async () => {
    while (next <= t1) {
      const t = next++;
      const raw = await fetchChunk(name, t, f);
      decoding = decoding.then(() => {
        if (!raw) return;
        bytes += raw.length;
        const out = zstd.decode(raw, CHUNK_BYTES);
        const v = new Int32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
        const first = Math.max(h0, t * RETRO_CHUNK_T);
        const last = Math.min(h1, t * RETRO_CHUNK_T + RETRO_CHUNK_T - 1);
        for (let h = first; h <= last; h++) {
          const x = v[(h - t * RETRO_CHUNK_T) * RETRO_CHUNK_F + c];
          if (x !== NWM_FILL) values[h - h0] = x * NWM_SCALE;
        }
      });
      await decoding;
    }
  };
  await Promise.all(Array.from({ length: Math.min(RETRO_FETCH_CONCURRENCY, t1 - t0 + 1) }, worker));
  return { times, values, bytes, chunks: t1 - t0 + 1 };
}
