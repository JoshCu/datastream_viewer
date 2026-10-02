// ====================================================================
// Winds aloft from Open-Meteo (free, no key, CORS-enabled): hourly wind,
// temperature and geopotential height on pressure levels for one point.
//
// Recent days come from the forecast API; older ones from the historical
// forecast API, which archives the same models back to 2021 (pressure levels
// aren't in the ERA5 archive API). Times are UTC. A fetch covers whole UTC
// days and is cached per (rounded point, days).
// ====================================================================

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast";
// The forecast API serves this many past days; older dates go to the archive.
const FORECAST_PAST_DAYS = 60;
export const EARLIEST_DATE = "2021-03-23";

// Lowest first. 1000–700 hPa covers the migration layer; the rest is for the
// panel (up to the jet stream).
export const LEVELS_HPA = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250];

const DAY_MS = 86400000;
const DEG = Math.PI / 180;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const cache = new Map(); // key → Promise<profile>

// Hourly profile for (lat, lon) over UTC days `startDate`..`endDate`
// (YYYY-MM-DD). Returns { lat, lon, elevation, times: [ms], levels: [{ hPa,
// height, u, v, speed, from, temp }] }, each per-hour array (null for
// missing): height m MSL, u/v/speed m/s, `from` the direction the wind blows
// from (°), temp °C. Levels below ground are left out.
export function fetchWinds(lat, lon, startDate, endDate = startDate) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${startDate},${endDate}`;
  if (!cache.has(key)) {
    const p = load(lat, lon, startDate, endDate);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

async function load(lat, lon, startDate, endDate) {
  if (startDate < EARLIEST_DATE) throw new Error(`Winds aloft only go back to ${EARLIEST_DATE}`);
  const recent = Date.parse(startDate) >= Date.now() - FORECAST_PAST_DAYS * DAY_MS;
  const hourly = LEVELS_HPA.flatMap((l) => [
    `wind_speed_${l}hPa`,
    `wind_direction_${l}hPa`,
    `geopotential_height_${l}hPa`,
    `temperature_${l}hPa`,
  ]);
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: startDate,
    end_date: endDate,
    hourly: hourly.join(","),
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    timezone: "GMT",
  });
  const res = await fetch(`${recent ? FORECAST_URL : HISTORICAL_URL}?${params}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Open-Meteo: ${body.reason ?? res.status}`);
  const h = body.hourly;
  const levels = LEVELS_HPA.map((hPa) => {
    const speed = h[`wind_speed_${hPa}hPa`];
    const from = h[`wind_direction_${hPa}hPa`];
    // Meteorological "from" direction → the u/v the air moves along.
    const comp = (f) => speed.map((s, i) => (s == null || from[i] == null ? null : f(s, from[i] * DEG)));
    return {
      hPa,
      height: h[`geopotential_height_${hPa}hPa`],
      speed,
      from,
      temp: h[`temperature_${hPa}hPa`],
      u: comp((s, d) => -s * Math.sin(d)),
      v: comp((s, d) => -s * Math.cos(d)),
    };
  }).filter((l) => l.height.some((z) => z != null && z > body.elevation));
  return {
    lat: body.latitude,
    lon: body.longitude,
    elevation: body.elevation,
    times: h.time.map((t) => t * 1000),
    levels,
  };
}

// The UTC days a window of ±1 h around `ms` touches, for fetchWinds.
export function daysAround(ms) {
  return [isoDate(ms - 3600000), isoDate(ms + 3600000)];
}

// Linear interpolation of x at t through sorted (ts, ys); null outside.
function lerp(ts, ys, t) {
  for (let i = 1; i < ts.length; i++) {
    if (t > ts[i]) continue;
    if (t < ts[i - 1]) return null;
    const w = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
    const a = ys[i - 1];
    const b = ys[i];
    // At a sample itself the other one may be missing.
    if (w === 0 || w === 1) return w ? b : a;
    if (a == null || b == null) return null;
    return a + (b - a) * w;
  }
  return null;
}

// Wind { u, v } (m/s) at `ms` and `heightMsl` (m), interpolated linearly in
// time between hours and in height between levels. Below the lowest level
// takes the lowest level; above the top, or outside the hours, null.
export function windAt(profile, ms, heightMsl) {
  const rows = profile.levels
    .map((l) => ({
      z: lerp(profile.times, l.height, ms),
      u: lerp(profile.times, l.u, ms),
      v: lerp(profile.times, l.v, ms),
    }))
    .filter((r) => r.z != null && r.u != null && r.v != null)
    .sort((a, b) => a.z - b.z);
  if (!rows.length) return null;
  if (heightMsl <= rows[0].z) return { u: rows[0].u, v: rows[0].v };
  const z = rows.map((r) => r.z);
  const u = lerp(z, rows.map((r) => r.u), heightMsl);
  const v = lerp(z, rows.map((r) => r.v), heightMsl);
  return u == null || v == null ? null : { u, v };
}
