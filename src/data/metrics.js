// ====================================================================
// Goodness-of-fit metrics between two time series (hydrograph compare).
//
// Pure functions over { times: epoch ms (ascending), values } series where
// missing values are NaN. The two series rarely share a clock — USGS gages
// report every 15 min, t-route writes hourly (or coarser) — so the reference
// series is linearly interpolated onto the simulated series' timestamps,
// but only across gaps no wider than a couple of its own steps, so a hole
// in the record is skipped rather than bridged.
// ====================================================================

const HOUR_MS = 60 * 60 * 1000;

// Pair `sim` with `ref` at each of sim's timestamps inside [x0, x1]. Returns
// { times, sim, ref } as plain arrays of the points where both are defined.
export function alignSeries(sim, ref, x0 = -Infinity, x1 = Infinity) {
  const out = { times: [], sim: [], ref: [] };
  const rt = ref.times;
  const rv = ref.values;
  if (!rt.length) return out;
  // Series built by the hydrograph already carry their median step; reuse it
  // rather than recomputing the same statistic once per run scored against the
  // same reference.
  const maxGap = Number.isFinite(ref.step)
    ? Math.max(HOUR_MS, 2 * ref.step)
    : gapTolerance(rt);
  let j = 0;
  for (let i = 0; i < sim.times.length; i++) {
    const t = sim.times[i];
    if (t < x0) continue;
    if (t > x1) break;
    const s = sim.values[i];
    if (Number.isNaN(s)) continue;
    while (j < rt.length && rt[j] < t) j++;
    let r = NaN;
    if (j < rt.length && rt[j] === t) {
      r = rv[j];
    } else if (j > 0 && j < rt.length && rt[j] - rt[j - 1] <= maxGap) {
      const a = rv[j - 1];
      r = a + ((rv[j] - a) * (t - rt[j - 1])) / (rt[j] - rt[j - 1]);
    }
    if (Number.isNaN(r)) continue;
    out.times.push(t);
    out.sim.push(s);
    out.ref.push(r);
  }
  return out;
}

// Median interval between consecutive timestamps. Strided: a long observation
// record is sampled rather than fully sorted, which is the same answer for
// orders of magnitude less work. Infinity for a series with no interval.
export function medianStep(times) {
  if (times.length < 2) return Infinity;
  const steps = [];
  const stride = Math.max(1, Math.floor(times.length / 500));
  for (let i = stride; i < times.length; i += stride) {
    steps.push((times[i] - times[i - stride]) / stride);
  }
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}

// Widest gap interpolation may bridge: two median steps, but never less than
// an hour so an hourly reference still interpolates onto sub-hourly output.
function gapTolerance(times) {
  const step = medianStep(times);
  return Number.isFinite(step) ? Math.max(HOUR_MS, 2 * step) : HOUR_MS;
}

// sim − ref at sim's timestamps, as a plottable series.
export function differenceSeries(sim, ref) {
  const { times, sim: s, ref: r } = alignSeries(sim, ref);
  const values = new Float32Array(times.length);
  for (let i = 0; i < times.length; i++) values[i] = s[i] - r[i];
  return { times: Float64Array.from(times), values };
}

// Standard hydrologic skill scores of `sim` against `obs` (equal-length
// arrays of paired values). Null when there are too few pairs to mean
// anything; individual scores are NaN when undefined (e.g. a flat record).
//   KGE   Kling-Gupta efficiency (2009): 1 − √((r−1)² + (α−1)² + (β−1)²)
//   NSE   Nash-Sutcliffe efficiency: 1 − Σ(s−o)² / Σ(o−ō)²
//   r     Pearson correlation
//   pbias 100·Σ(s−o)/Σo, positive = sim over-predicts
export function computeMetrics(sim, obs) {
  const n = sim.length;
  if (n < 3) return null;
  let ms = 0;
  let mo = 0;
  for (let i = 0; i < n; i++) {
    ms += sim[i];
    mo += obs[i];
  }
  ms /= n;
  mo /= n;

  let sso = 0; // Σ(o−ō)²
  let sss = 0; // Σ(s−s̄)²
  let cov = 0;
  let sse = 0; // Σ(s−o)²
  let sae = 0;
  let sumErr = 0;
  let sumObs = 0;
  for (let i = 0; i < n; i++) {
    const ds = sim[i] - ms;
    const dob = obs[i] - mo;
    const e = sim[i] - obs[i];
    sso += dob * dob;
    sss += ds * ds;
    cov += ds * dob;
    sse += e * e;
    sae += Math.abs(e);
    sumErr += e;
    sumObs += obs[i];
  }

  const r = sss > 0 && sso > 0 ? cov / Math.sqrt(sss * sso) : NaN;
  const alpha = sso > 0 ? Math.sqrt(sss / sso) : NaN;
  const beta = mo !== 0 ? ms / mo : NaN;
  return {
    n,
    kge: 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2),
    nse: sso > 0 ? 1 - sse / sso : NaN,
    r,
    pbias: sumObs !== 0 ? (100 * sumErr) / sumObs : NaN,
    rmse: Math.sqrt(sse / n),
    mae: sae / n,
  };
}
