// ====================================================================
// Loaded-dataset accessors
//
// Tiny leaf module (imports only state) so both map painting and the UI
// panels can read per-reach values without creating an import cycle.
// ====================================================================
import { state } from "../state.js";

export function valueAt(variable, row, timeIndex) {
  const m = state.data.matrices[variable];
  return m[row * state.data.nTimes + timeIndex];
}

// Absolute UTC epoch milliseconds for a raw entry of state.data.time. Parquet
// runs already carry epoch ms; NetCDF runs carry seconds since the file's
// reference time. Returns undefined when the reference time is unparseable.
export function timeToMillis(t) {
  if (state.data.isParquet) return t;
  const ref = refTimeMillis();
  return ref === undefined ? undefined : ref + t * 1000;
}

// Time range [start, end] of the loaded run in epoch ms, or null when it
// can't be resolved to absolute time.
export function dataTimeRangeMs() {
  const { time } = state.data;
  if (!time.length) return null;
  const start = timeToMillis(time[0]);
  const end = timeToMillis(time[time.length - 1]);
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

// t-route writes file_reference_time as "YYYY-MM-DD HH:MM:SS" (sometimes with
// "_" or "T" as the separator) and no timezone; it is UTC.
function refTimeMillis() {
  const raw = state.data.refTime;
  if (typeof raw !== "string") return undefined;
  let s = raw.trim().replace(/^(\d{4}-\d{2}-\d{2})[ _]/, "$1T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}
