// ====================================================================
// Diff between two already-loaded sources (A − B), computed on the main
// thread since it's plain array subtraction over data already resident
// there — no worker round-trip needed.
//
// Inputs are two normalized datasets shaped like state.data (featureIds,
// index, nTimes, time, matrices). Output is shaped the same way (isDiff:
// true) so it can be promoted straight into state.data and painted with
// the existing pipeline.
// ====================================================================
import { FILL_VALUE, VARIABLE_KEYS, isValid } from "../config.js";

export function diffDatasets(a, b) {
  // Feature intersection: only reaches present in both sources are
  // comparable. Order follows A for a stable, deterministic result.
  const featureIds = [];
  const aRows = [];
  const bRows = [];
  for (const [fid, aRow] of a.index) {
    const bRow = b.index.get(fid);
    if (bRow !== undefined) {
      featureIds.push(fid);
      aRows.push(aRow);
      bRows.push(bRow);
    }
  }
  if (featureIds.length === 0) {
    throw new Error("No overlapping feature ids between the two sources");
  }

  // Time intersection: match by exact time value rather than by index, so
  // two runs with different lengths or offsets still align correctly on the
  // timesteps they share.
  const bTimeIndex = new Map(b.time.map((t, i) => [+t, i]));
  const timePairs = [];
  a.time.forEach((t, i) => {
    const j = bTimeIndex.get(+t);
    if (j !== undefined) timePairs.push([i, j]);
  });
  if (timePairs.length === 0) {
    throw new Error("No overlapping timesteps between the two sources");
  }

  const nFeatures = featureIds.length;
  const nTimes = timePairs.length;
  const time = timePairs.map(([ai]) => a.time[ai]);
  // Flat column maps: the cell loop below runs nFeatures * nTimes * nVariables
  // times on the main thread, so it indexes typed arrays rather than
  // destructuring a nested pair on every iteration.
  const aCols = Int32Array.from(timePairs, (p) => p[0]);
  const bCols = Int32Array.from(timePairs, (p) => p[1]);

  const diffVariable = (varName) => {
    const out = new Float32Array(nFeatures * nTimes).fill(FILL_VALUE);
    const av = a.matrices[varName];
    const bv = b.matrices[varName];
    for (let fi = 0; fi < nFeatures; fi++) {
      const aBase = aRows[fi] * a.nTimes;
      const bBase = bRows[fi] * b.nTimes;
      const outBase = fi * nTimes;
      for (let ti = 0; ti < nTimes; ti++) {
        const x = av[aBase + aCols[ti]];
        const y = bv[bBase + bCols[ti]];
        if (isValid(x) && isValid(y)) out[outBase + ti] = x - y;
      }
    }
    return out;
  };

  const matrices = Object.fromEntries(
    VARIABLE_KEYS.map((v) => [v, diffVariable(v)]),
  );

  const featureIdsArr = Float64Array.from(featureIds);
  const index = new Map();
  for (let i = 0; i < featureIdsArr.length; i++) index.set(featureIdsArr[i], i);

  return {
    isDiff: true,
    // Both inputs are already normalized to epoch ms; the diff keeps whichever
    // clock both sides share.
    timeAbsolute: a.timeAbsolute && b.timeAbsolute,
    time,
    nTimes,
    featureIds: featureIdsArr,
    index,
    matrices,
    bounds: Object.fromEntries(
      VARIABLE_KEYS.map((v) => [v, diffBounds(matrices[v])]),
    ),
    refTime: a.refTime,
  };
}

// Symmetric bounds around zero (max absolute value on both sides) so the
// diverging color ramp centers its pale stop on "no difference".
function diffBounds(arr) {
  let maxAbs = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isValid(v)) {
      const m = Math.abs(v);
      if (m > maxAbs) maxAbs = m;
    }
  }
  if (maxAbs === 0) maxAbs = 1;
  return { min: -maxAbs, max: maxAbs };
}
