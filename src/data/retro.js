// ====================================================================
// NWM retrospective 3.0: one reach's series over a window, for the
// hydrograph. DOM-free. The reach's column comes from the operational
// COMID table (same order; data/nwm.js), the chunk reads and zstd decode
// run in the parse worker (data/workers/retro.js).
//
// Chunks hold 672 hours (28 days), so a window costs one chunk per 28 days
// it touches: ~1–6 MB each, which retroEstimate() measures with HEAD
// requests before anything is downloaded.
// ====================================================================
import {
  RETRO_BASE,
  RETRO_CHUNK_F,
  RETRO_CHUNK_T,
  RETRO_N_TIMES,
  RETRO_T0_MS,
  RETRO_VARIABLES,
} from "../config.js";
import { runTask } from "./loader.js";
import { nwmFeatureTable, nwmRowOf } from "./nwm.js";

const HOUR_MS = 3600 * 1000;

// The record's span, epoch ms (inclusive).
export const RETRO_START_MS = RETRO_T0_MS;
export const RETRO_END_MS = RETRO_T0_MS + (RETRO_N_TIMES - 1) * HOUR_MS;

// Hour indexes of [startMs, endMs], clamped to the record; null if they
// miss it.
function hourRange(startMs, endMs) {
  const h0 = Math.max(0, Math.ceil((startMs - RETRO_T0_MS) / HOUR_MS));
  const h1 = Math.min(RETRO_N_TIMES - 1, Math.floor((endMs - RETRO_T0_MS) / HOUR_MS));
  return h1 >= h0 ? { h0, h1 } : null;
}

async function columnOf(comid) {
  const { ids } = await nwmFeatureTable();
  const col = nwmRowOf(ids, comid);
  if (col < 0) throw new Error(`COMID ${comid} isn't in the NWM network`);
  return col;
}

// What a window costs: { chunks, bytes } from each chunk's Content-Length.
export async function retroEstimate(comid, variable, startMs, endMs) {
  const range = hourRange(startMs, endMs);
  if (!range) return { chunks: 0, bytes: 0 };
  const f = Math.floor((await columnOf(comid)) / RETRO_CHUNK_F);
  const name = RETRO_VARIABLES[variable];
  const ts = [];
  for (let t = Math.floor(range.h0 / RETRO_CHUNK_T); t <= Math.floor(range.h1 / RETRO_CHUNK_T); t++) ts.push(t);
  const sizes = await Promise.all(
    ts.map(async (t) => {
      const res = await fetch(`${RETRO_BASE}/${name}/${t}.${f}`, { method: "HEAD" });
      return res.ok ? Number(res.headers.get("content-length")) || 0 : 0;
    }),
  );
  return { chunks: ts.length, bytes: sizes.reduce((a, b) => a + b, 0) };
}

// { times (epoch ms), values (NaN = no data), bytes } for one reach.
export async function retroSeries(comid, variable, startMs, endMs) {
  const name = RETRO_VARIABLES[variable];
  if (!name) throw new Error(`The retrospective has no ${variable}`);
  const range = hourRange(startMs, endMs);
  if (!range) throw new Error("Window is outside the retrospective (1979-02-01 to 2023-02-01)");
  const col = await columnOf(comid);
  return runTask({ type: "retroSeries", name, col, ...range });
}
