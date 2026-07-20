// ====================================================================
// Distribution-based class breaks (quantile / Jenks natural breaks)
// ====================================================================
import { state } from "../state.js";
import { strictlyIncreasing } from "./scales.js";

// Sorted sample of the current variable's valid values (strided across the
// whole feature x time matrix), cached per variable. The distribution
// scales (quantile / classed / Jenks) work off this rather than every cell.
export function resultSamples() {
  state.data.samples = state.data.samples || {};
  const cached = state.data.samples[state.variable];
  if (cached) return cached;
  const m = state.data.matrices[state.variable];
  const stride = Math.max(1, Math.floor(m.length / 50000));
  const out = [];
  for (let i = 0; i < m.length; i += stride) {
    if (m[i] > -9998) out.push(m[i]);
  }
  out.sort((a, b) => a - b);
  const arr = Float64Array.from(out);
  state.data.samples[state.variable] = arr;
  return arr;
}

export function quantileOf(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Jenks natural breaks. data must be sorted ascending; returns nClasses+1
// boundaries (min..max). O(n^2·k), so the caller downsamples first.
export function jenksBreaks(data, nClasses) {
  const n = data.length;
  if (n === 0) return [];
  if (nClasses >= n) nClasses = n;

  const lower = [];
  const variance = [];
  for (let i = 0; i <= n; i++) {
    lower.push(new Array(nClasses + 1).fill(0));
    variance.push(new Array(nClasses + 1).fill(0));
  }
  for (let j = 1; j <= nClasses; j++) {
    lower[1][j] = 1;
    variance[1][j] = 0;
    for (let i = 2; i <= n; i++) variance[i][j] = Infinity;
  }
  for (let l = 2; l <= n; l++) {
    let sum = 0;
    let sumSq = 0;
    let w = 0;
    let v = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = data[i3 - 1];
      w += 1;
      sum += val;
      sumSq += val * val;
      v = sumSq - (sum * sum) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= nClasses; j++) {
          if (variance[l][j] >= v + variance[i4][j - 1]) {
            lower[l][j] = i3;
            variance[l][j] = v + variance[i4][j - 1];
          }
        }
      }
    }
    lower[l][1] = 1;
    variance[l][1] = v;
  }
  const kclass = new Array(nClasses + 1);
  kclass[0] = data[0];
  kclass[nClasses] = data[n - 1];
  let k = n;
  for (let j = nClasses; j >= 2; j--) {
    const id = lower[k][j] - 1;
    kclass[j - 1] = data[id];
    k = lower[k][j] - 1;
  }
  return kclass;
}

// Interior class boundaries (length nClasses-1) for the classed scales,
// cached per (variable, scale).
export function resultBreaks(scale, nClasses) {
  state.data.breaks = state.data.breaks || {};
  const key = state.variable + ":" + scale;
  if (state.data.breaks[key]) return state.data.breaks[key];

  const samples = resultSamples();
  let breaks;
  if (scale === "jenks") {
    // Downsample so the O(n^2) DP stays fast.
    const cap = 1000;
    let data = samples;
    if (samples.length > cap) {
      const stride = samples.length / cap;
      data = new Float64Array(cap);
      for (let i = 0; i < cap; i++) data[i] = samples[Math.floor(i * stride)];
    }
    breaks = jenksBreaks(data, nClasses).slice(1, nClasses);
  } else {
    // Quantile classification: equal-count classes.
    breaks = [];
    for (let i = 1; i < nClasses; i++)
      breaks.push(quantileOf(samples, i / nClasses));
  }
  breaks = strictlyIncreasing(breaks);
  state.data.breaks[key] = breaks;
  return breaks;
}
