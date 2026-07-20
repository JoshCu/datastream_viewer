// ====================================================================
// Dataset merge + bounds (worker-side, pure).
// ====================================================================
import { FILL_VALUE } from "../../config.js";

// Merge many single-VPU datasets into one, taking the union of timestamps
// and concatenating the (disjoint) feature sets. Missing cells stay at the
// fill value so they render as no-data.
export function mergeDatasets(datasets) {
  const isParquet = datasets.some((d) => d.isParquet);

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

  const alloc = () => {
    const a = new Float32Array(nF * nTimes);
    a.fill(FILL_VALUE);
    return a;
  };
  const out = { flow: alloc(), velocity: alloc(), depth: alloc() };

  for (const d of datasets) {
    const cols = d.time.map((t) => timeCol.get(+t));
    for (const v of ["flow", "velocity", "depth"]) {
      const src = d[v];
      if (!src || !src.length) continue;
      for (let lf = 0; lf < d.featureIds.length; lf++) {
        const base = rowOf.get(d.featureIds[lf]) * nTimes;
        const sbase = lf * d.nTimes;
        for (let lt = 0; lt < d.nTimes; lt++) {
          out[v][base + cols[lt]] = src[sbase + lt];
        }
      }
    }
  }

  return {
    isParquet,
    time,
    nTimes,
    featureIds,
    flow: out.flow,
    velocity: out.velocity,
    depth: out.depth,
    refTime: datasets[0]?.refTime,
  };
}

export function computeBounds(arr) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > -9998) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) return { min: 0, max: 1 };
  return { min, max };
}

// Bounds for all three variables of a dataset in one place.
export function computeAllBounds(dataset) {
  return {
    flow: computeBounds(dataset.flow),
    velocity: computeBounds(dataset.velocity),
    depth: computeBounds(dataset.depth),
  };
}
