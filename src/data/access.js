// ====================================================================
// Loaded-dataset accessors
//
// Tiny leaf module (imports only state + config) so both map painting and the
// UI panels can read per-reach values without creating an import cycle.
//
// Every function here takes the dataset it works on, defaulting to the run
// currently painted on the map. That default is a convenience, not an
// assumption: the hydrograph and the diff pickers routinely need values from a
// dataset that isn't the active one.
// ====================================================================
import { state } from "../state.js";
import { isValid } from "../config.js";

export function valueAt(variable, row, timeIndex, data = state.data) {
  return data.matrices[variable][row * data.nTimes + timeIndex];
}

// Absolute UTC epoch milliseconds for a raw entry of `data.time`. Parsers
// normalize every clock to epoch ms (see parsers/netcdf.js), so this is the
// identity whenever the run has an absolute clock at all. Returns undefined for
// a run whose reference time was unparseable, where `time` is still raw
// seconds and no absolute instant can be recovered.
export function timeToMillis(t, data = state.data) {
  return data.timeAbsolute ? t : undefined;
}

// Time range [start, end] of the run in epoch ms, or null when it can't be
// resolved to absolute time.
export function dataTimeRangeMs(data = state.data) {
  const { time } = data;
  if (!time.length || !data.timeAbsolute) return null;
  return { start: time[0], end: time[time.length - 1] };
}

// One reach's time series from a dataset, as plottable parallel arrays with
// the fill value mapped to NaN. The matrices are time-sorted by construction,
// so this is a straight strided copy — no intermediate pairs, no sort.
//
// A run and a USGS gage record then differ only in where the series came from,
// not in what a series is.
export function seriesAt(dataset, reachId, variable) {
  const row = dataset.index.get(reachId);
  if (row === undefined || !dataset.timeAbsolute) return null;
  const n = dataset.nTimes;
  const m = dataset.matrices[variable];
  const base = row * n;
  const times = new Float64Array(n);
  const values = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    times[t] = dataset.time[t];
    const v = m[base + t];
    values[t] = isValid(v) ? v : NaN;
  }
  return { times, values };
}

// ---- Derived-value cache -------------------------------------------
//
// Bounds, distribution samples, class breaks and per-timestep totals are all
// pure functions of (dataset, variable). They're expensive enough to be worth
// caching and cheap enough to compute lazily, so one bag per dataset holds
// them all rather than each consumer bolting its own `x = x || {}` onto
// state.data.
export function derived(dataset, variable) {
  let bag = dataset._derived;
  if (!bag) {
    bag = new Map();
    // Non-enumerable so the cache never rides along in a structured clone or
    // shows up when a dataset is spread.
    Object.defineProperty(dataset, "_derived", { value: bag, writable: true });
  }
  let entry = bag.get(variable);
  if (!entry) {
    entry = {};
    bag.set(variable, entry);
  }
  return entry;
}
