// ====================================================================
// Distribution-based class breaks (quantile / Jenks natural breaks)
// ====================================================================
import { isValid } from "../config.js";
import { derived } from "../data/access.js";
import { strictlyIncreasing } from "./scales.js";

// Sorted sample of `variable`'s valid values (strided across the
// whole feature x time matrix), cached per variable. The distribution
// scales (quantile / classed / Jenks) work off this rather than every cell.
export function resultSamples(dataset, variable) {
  const cache = derived(dataset, variable);
  if (cache.samples) return cache.samples;
  const m = dataset.matrices[variable];
  const stride = Math.max(1, Math.floor(m.length / 50000));
  const out = [];
  for (let i = 0; i < m.length; i += stride) {
    if (isValid(m[i])) out.push(m[i]);
  }
  out.sort((a, b) => a - b);
  cache.samples = Float64Array.from(out);
  return cache.samples;
}

// Sorted |value| sample, for the signed (diff) forms of the distribution
// scales, which classify magnitudes and mirror them around zero.
export function magnitudeSamples(dataset, variable) {
  const cache = derived(dataset, variable);
  if (cache.magnitudes) return cache.magnitudes;
  cache.magnitudes = resultSamples(dataset, variable)
    .map(Math.abs)
    .sort();
  return cache.magnitudes;
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

// Interior class boundaries (length nColors-1) for the classed scales,
// cached per (dataset, variable, scale, nColors) since colour maps differ in
// length. A diff classifies |value| into half as many classes and mirrors the
// boundaries, so the classes are symmetric and an odd-length map's middle
// colour is the class around zero.
export function resultBreaks(dataset, variable, scale, nColors) {
  const cache = derived(dataset, variable);
  cache.breaks = cache.breaks || {};
  const key = `${scale}:${nColors}`;
  if (cache.breaks[key]) return cache.breaks[key];

  let breaks;
  if (dataset.isDiff) {
    const mag = classBreaks(
      magnitudeSamples(dataset, variable),
      scale,
      Math.ceil(nColors / 2),
    );
    const neg = mag.map((b) => -b).reverse();
    breaks = nColors % 2 ? [...neg, ...mag] : [...neg, 0, ...mag];
  } else {
    breaks = classBreaks(resultSamples(dataset, variable), scale, nColors);
  }
  breaks = strictlyIncreasing(breaks);
  cache.breaks[key] = breaks;
  return breaks;
}

// Interior boundaries splitting sorted `samples` into nClasses classes.
function classBreaks(samples, scale, nClasses) {
  if (scale === "jenks") {
    // Downsample so the O(n^2) DP stays fast.
    const cap = 1000;
    let data = samples;
    if (samples.length > cap) {
      const stride = samples.length / cap;
      data = new Float64Array(cap);
      for (let i = 0; i < cap; i++) data[i] = samples[Math.floor(i * stride)];
    }
    return jenksBreaks(data, nClasses).slice(1, nClasses);
  }
  // Quantile classification: equal-count classes.
  const breaks = [];
  for (let i = 1; i < nClasses; i++)
    breaks.push(quantileOf(samples, i / nClasses));
  return breaks;
}
