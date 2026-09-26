// ====================================================================
// Dataset merge + bounds (worker-side, pure).
// ====================================================================
import { FILL_VALUE, VARIABLE_KEYS, isValid } from "../../config.js";

// Merge many single-VPU datasets into one, taking the union of timestamps
// and concatenating the (disjoint) feature sets. Missing cells stay at the
// fill value so they render as no-data.
export function mergeDatasets(datasets) {
  // Every parser normalizes its clock to epoch ms, so a merged run only has an
  // absolute clock if *all* its inputs do. Taken with `every` rather than
  // `some`: one relative-time member would otherwise have its raw seconds read
  // as milliseconds by every consumer.
  const timeAbsolute = datasets.every((d) => d.timeAbsolute);

  const timeSet = new Set();
  datasets.forEach((d) => d.time.forEach((t) => timeSet.add(+t)));
  const time = Array.from(timeSet).sort((a, b) => a - b);
  const nTimes = time.length;
  const timeCol = new Map(time.map((t, i) => [t, i]));

  const featureIds = [];
  const seen = new Set();
  datasets.forEach((d) =>
    d.featureIds.forEach((id) => {
      if (!seen.has(id)) {
        seen.add(id);
        featureIds.push(id);
      }
    }),
  );
  const rowOf = new Map(featureIds.map((id, i) => [id, i]));
  const nF = featureIds.length;

  const matrices = Object.fromEntries(
    VARIABLE_KEYS.map((v) => {
      const a = new Float32Array(nF * nTimes);
      a.fill(FILL_VALUE);
      return [v, a];
    }),
  );

  for (const d of datasets) {
    // Flat column map for this member, so the innermost loop indexes a typed
    // array instead of walking a JS array of boxed numbers.
    const cols = Int32Array.from(d.time, (t) => timeCol.get(+t));
    for (const v of VARIABLE_KEYS) {
      const src = d.matrices[v];
      if (!src || !src.length) continue;
      const dst = matrices[v]; // hoisted: CONUS runs this ~10^8 times
      for (let lf = 0; lf < d.featureIds.length; lf++) {
        const base = rowOf.get(d.featureIds[lf]) * nTimes;
        const sbase = lf * d.nTimes;
        for (let lt = 0; lt < d.nTimes; lt++) {
          dst[base + cols[lt]] = src[sbase + lt];
        }
      }
    }
  }

  return {
    time,
    timeAbsolute,
    nTimes,
    featureIds,
    matrices,
    refTime: datasets[0]?.refTime,
  };
}

export function computeBounds(arr) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isValid(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) return { min: 0, max: 1 };
  return { min, max };
}

// Bounds for every variable of a dataset in one place.
export function computeAllBounds(dataset) {
  return Object.fromEntries(
    VARIABLE_KEYS.map((v) => [v, computeBounds(dataset.matrices[v])]),
  );
}
