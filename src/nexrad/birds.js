// ====================================================================
// Bird mode's vertical profile (pure): solve the per-height sums from the
// decoder (data/workers/nexrad.js) into mean density and a VAD fit.
//
// The VAD fits v_r / cos(el) = u·sin(az) + v·cos(az) + c over the bird gates
// in each height bin, giving the ground velocity (u east, v north) of what
// the radar sees. Without winds aloft this is ground speed, not airspeed, so
// it can't tell birds from insects drifting on the wind (airspeed < ~5 m/s).
// ====================================================================
import { PF, PROFILE_BIN_M, PROFILE_BINS, PROFILE_FIELDS, PROFILE_SECTORS } from "../data/workers/nexrad.js";

// A VAD needs enough samples spread around the compass.
const MIN_VAD_SAMPLES = 50;
const MIN_SECTOR_SAMPLES = 5;
const MIN_SECTORS = 6;

// Solve the 3×3 system A·x = b by Cramer's rule; null if singular.
function solve3(A, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-9) return null;
  const col = (k) => A.map((row, i) => row.map((x, j) => (j === k ? b[i] : x)));
  return [0, 1, 2].map((k) => det(col(k)) / d);
}

function vad(f) {
  if (f[PF.n] < MIN_VAD_SAMPLES) return null;
  let sectors = 0;
  for (let k = 0; k < PROFILE_SECTORS; k++) if (f[PF.sector0 + k] >= MIN_SECTOR_SAMPLES) sectors++;
  if (sectors < MIN_SECTORS) return null;
  const A = [
    [f[PF.ss], f[PF.sc], f[PF.s]],
    [f[PF.sc], f[PF.cc], f[PF.c]],
    [f[PF.s], f[PF.c], f[PF.n]],
  ];
  const x = solve3(A, [f[PF.sv], f[PF.cv], f[PF.v]]);
  if (!x) return null;
  const [u, v] = x;
  return { speed: Math.hypot(u, v), heading: ((Math.atan2(u, v) / (Math.PI / 180)) + 360) % 360 };
}

// One row per height bin with any gates: { bottom, top } metres above the
// radar, density (mean birds/km³, empty gates counted as 0), and speed (m/s)
// / heading (degrees, the direction flown toward) or null when the VAD
// can't be fit.
export function birdProfile(sums) {
  const rows = [];
  for (let b = 0; b < PROFILE_BINS; b++) {
    const f = sums.subarray(b * PROFILE_FIELDS, (b + 1) * PROFILE_FIELDS);
    if (!f[PF.densN]) continue;
    rows.push({
      bottom: b * PROFILE_BIN_M,
      top: (b + 1) * PROFILE_BIN_M,
      density: f[PF.densSum] / f[PF.densN],
      ...(vad(f) ?? { speed: null, heading: null }),
    });
  }
  return rows;
}

// 0° → "N", 45° → "NE", …
export function compass(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

// Approximate solar elevation (degrees) at `ms` epoch over lat/lon. Most
// songbirds migrate at night, so daytime echoes are more likely insects.
export function sunElevation(ms, lat, lon) {
  const rad = Math.PI / 180;
  const day = ms / 86400000 + 2440587.5 - 2451545; // days since J2000
  const g = (357.529 + 0.98560028 * day) * rad; // mean anomaly
  const q = 280.459 + 0.98564736 * day; // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const e = (23.439 - 0.00000036 * day) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * day) * 15 * rad;
  const ha = gmst + lon * rad - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return el / rad;
}
