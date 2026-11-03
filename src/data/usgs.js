// ====================================================================
// USGS Water Data OGC API client: station metadata and continuous discharge
// for one gage, with a two-level cache so re-hovering or re-clicking a gage
// (or reloading the page) doesn't hit the API again.
//
//   - in-flight/parsed series are memoised per URL for the session
//   - raw JSON pages are stored in the Cache API (persists across reloads,
//     expires after CACHE_MAX_AGE_MS) when available, else fetched fresh
// ====================================================================
import { USGS_API, USGS_FLOW_PARAM, CFS_TO_CMS } from "../config.js";

const CACHE_NAME = "usgs-continuous-v2"; // v2: per-year windows, trimmed properties
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = "x-cached-at";
const MAX_PAGES = 20; // per window (a year): 50k rows/page; 15-min data is ~35k rows/year
const OBS_CONCURRENCY = 3; // windows in flight at once
const FETCH_TIMEOUT_MS = 90_000; // per request; a year's page takes ~5 s
const RETRIES = 3; // after the first try, for timeouts, 429 and 5xx
const RETRY_BASE_MS = 1000; // doubled per retry, unless Retry-After says

const seriesMemo = new Map(); // url -> Promise<series>
const metaMemo = new Map(); // site -> Promise<meta>

// Memoize an in-flight/resolved promise per key, without caching failures —
// a transient network error shouldn't poison the entry for the session.
function memo(cache, key, load) {
  if (!cache.has(key)) {
    cache.set(
      key,
      load().catch((err) => {
        cache.delete(key);
        throw err;
      }),
    );
  }
  return cache.get(key);
}

// Station properties worth showing next to a modelled hydrograph: what the
// gage is, how big a basin it drains, and where its datum sits.
const SITE_PROPS = [
  "monitoring_location_name",
  "site_type",
  "drainage_area",
  "altitude",
  "vertical_datum",
].join(",");
const SERIES_PROPS = [
  "parameter_code",
  "parameter_name",
  "unit_of_measure",
  "begin",
  "end",
].join(",");

// Metadata for a USGS site number: station name/type/basin plus the period of
// record of every continuous ("Points") time series it publishes. Two requests,
// memoised per site and Cache-API backed, so a gage is only ever looked up once.
// Resolves to { site, name, siteType, drainageArea (mi2), altitude (ft),
// verticalDatum, lonLat ([lon, lat] or null), series: [{ code, name, units,
// beginMs, endMs }], flow }.
export function fetchGageMeta(site) {
  return memo(metaMemo, site, () => loadMeta(site));
}

// The memoised metadata promise for a site, or undefined if it was never
// requested. Lets the hover tooltip skip its debounce for an already-known gage.
export function peekGageMeta(site) {
  return metaMemo.get(site);
}

async function loadMeta(site) {
  const locUrl = `${USGS_API}/collections/monitoring-locations/items?${new URLSearchParams(
    // With its geometry (a point): the catchment search locates gages by it.
    { id: `USGS-${site}`, properties: SITE_PROPS, f: "json" },
  )}`;
  // Only continuous series: those are what the hydrograph compares against, and
  // dropping the daily/statistical variants keeps the response a few KB.
  const seriesUrl = `${USGS_API}/collections/time-series-metadata/items?${new URLSearchParams(
    {
      monitoring_location_id: `USGS-${site}`,
      computation_period_identifier: "Points",
      properties: SERIES_PROPS,
      skipGeometry: "true",
      limit: "200",
      f: "json",
    },
  )}`;

  // Either half is worth showing on its own; only a total failure is an error.
  const [loc, features] = await Promise.all([
    fetchJsonCached(locUrl)
      .then(({ json }) => json.features?.[0] ?? null)
      .catch(() => null),
    fetchJsonCached(seriesUrl)
      .then(({ json }) => json.features ?? [])
      .catch(() => null),
  ]);
  if (!loc && !features) throw new Error("USGS metadata unavailable");

  const series = summarizeSeries(features || []);
  const props = loc?.properties;
  const xy = loc?.geometry?.coordinates;
  return {
    site,
    name: props?.monitoring_location_name ?? null,
    siteType: props?.site_type ?? null,
    drainageArea: numberOrNull(props?.drainage_area),
    altitude: numberOrNull(props?.altitude),
    verticalDatum: props?.vertical_datum ?? null,
    lonLat: xy && numberOrNull(xy[0]) != null && numberOrNull(xy[1]) != null
      ? [xy[0], xy[1]]
      : null,
    series,
    flow: series.find((s) => s.code === USGS_FLOW_PARAM) ?? null,
  };
}

// One entry per parameter, most recently active first. A parameter often has
// several series at a site (sensor swaps, sondes); their records are merged into
// a single span so the tooltip can answer "does this gage cover my run?".
function summarizeSeries(features) {
  const byCode = new Map();
  for (const f of features) {
    const p = f.properties || {};
    if (!p.parameter_code) continue;
    const beginMs = Date.parse(p.begin);
    const endMs = Date.parse(p.end);
    const prev = byCode.get(p.parameter_code);
    if (prev) {
      if (beginMs < prev.beginMs) prev.beginMs = beginMs;
      if (endMs > prev.endMs) prev.endMs = endMs;
    } else {
      byCode.set(p.parameter_code, {
        code: p.parameter_code,
        name: p.parameter_name || p.parameter_code,
        units: p.unit_of_measure || "",
        beginMs,
        endMs,
      });
    }
  }
  for (const s of byCode.values()) {
    if (!Number.isFinite(s.beginMs)) s.beginMs = null;
    if (!Number.isFinite(s.endMs)) s.endMs = null;
  }
  return [...byCode.values()].sort((a, b) => (b.endMs ?? 0) - (a.endMs ?? 0));
}

function numberOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Fetch discharge observations for a USGS site number over [startMs, endMs].
// Resolves to { site, times: Float64Array (epoch ms), values: Float32Array
// (m³/s), units, fromCache, failed } with points sorted by time.
//
// The API rejects a time envelope over 1100 days (HTTP 400), and a multi-year
// page chain is slow enough to time out, so the range is split into
// calendar-year windows (~35k rows of 15-min data, one ~1 MB page each),
// fetched a few at a time and joined. Each window is memoised and cached on
// its own: windows are aligned to the year, so a later request that overlaps
// reuses every whole year it shares. A window that still fails after its
// retries is left out and counted in `failed` (windows), rather than losing
// the years that did arrive; only all of them failing is an error.
// `onProgress(done, total)` reports finished windows.
export async function fetchGageFlow(site, startMs, endMs, { onProgress } = {}) {
  const windows = splitWindows(startMs, endMs);
  let done = 0;
  let failed = 0;
  let firstError = null;
  const parts = new Array(windows.length);
  const queue = windows.map((w, i) => i);
  async function worker() {
    while (queue.length) {
      const i = queue.shift();
      const [a, b] = windows[i];
      const url = itemsUrl(site, a, b);
      try {
        parts[i] = await memo(seriesMemo, url, () => loadSeries(url));
      } catch (err) {
        failed++;
        firstError ??= err;
      }
      onProgress?.(++done, windows.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(OBS_CONCURRENCY, windows.length) }, worker));
  if (failed === windows.length) throw firstError;
  return { site, ...joinWindows(parts.filter(Boolean)), failed, windows: windows.length };
}

// [startMs, endMs] as UTC calendar-year windows, clipped to the range.
function splitWindows(startMs, endMs) {
  const out = [];
  let a = startMs;
  while (a < endMs) {
    const next = Date.UTC(new Date(a).getUTCFullYear() + 1, 0, 1);
    const b = Math.min(next, endMs);
    out.push([a, b]);
    a = b;
  }
  return out.length ? out : [[startMs, endMs]];
}

// The windows' points in time order. Windows share their boundary instant
// (the API's interval is closed), so a point no later than the last kept one
// is a repeat.
function joinWindows(parts) {
  const total = parts.reduce((n, p) => n + p.times.length, 0);
  const times = new Float64Array(total);
  const values = new Float32Array(total);
  let n = 0;
  for (const p of parts) {
    for (let i = 0; i < p.times.length; i++) {
      if (n && p.times[i] <= times[n - 1]) continue;
      times[n] = p.times[i];
      values[n] = p.values[i];
      n++;
    }
  }
  return {
    times: times.subarray(0, n),
    values: values.subarray(0, n),
    units: "m³/s",
    rawUnits: parts.find((p) => p.rawUnits)?.rawUnits ?? null,
    fromCache: parts.length > 0 && parts.every((p) => p.fromCache),
  };
}

function itemsUrl(site, startMs, endMs) {
  const params = new URLSearchParams({
    monitoring_location_id: `USGS-${site}`,
    parameter_code: USGS_FLOW_PARAM,
    time: `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`,
    // Only what's read: a third of the payload, and the server answers ~3×
    // faster than for whole features.
    properties: "time,value,unit_of_measure",
    skipGeometry: "true",
    limit: "50000",
    f: "json",
  });
  return `${USGS_API}/collections/continuous/items?${params}`;
}

async function loadSeries(firstUrl) {
  const ts = [];
  const vs = [];
  let ordered = true;
  let units = null;
  let fromCache = true;
  let url = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const { json, cached } = await fetchJsonCached(url);
    fromCache &&= cached;
    for (const f of json.features || []) {
      const p = f.properties;
      const t = Date.parse(p.time);
      const v = parseFloat(p.value);
      if (Number.isNaN(t) || Number.isNaN(v)) continue;
      units ??= p.unit_of_measure;
      if (ordered && ts.length && t < ts[ts.length - 1]) ordered = false;
      ts.push(t);
      vs.push(v);
    }
    url = (json.links || []).find((l) => l.rel === "next")?.href;
  }

  // Pages come back in order, so the sort is only paid for when the API
  // actually hands back something out of order.
  let order = null;
  if (!ordered) {
    order = Array.from(ts.keys()).sort((a, b) => ts[a] - ts[b]);
  }
  const n = ts.length;
  const times = new Float64Array(n);
  const values = new Float32Array(n);
  // The API reports discharge in ft³/s; convert to match t-route's m³/s.
  const toCms = /ft/.test(units || "") ? CFS_TO_CMS : 1;
  for (let i = 0; i < n; i++) {
    const j = order ? order[i] : i;
    times[i] = ts[j];
    values[i] = vs[j] * toCms;
  }
  return { times, values, rawUnits: units, fromCache };
}

// GET a JSON URL, serving from the Cache API when a fresh-enough copy exists.
async function fetchJsonCached(url) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const age = Date.now() - Number(hit.headers.get(CACHED_AT_HEADER) || 0);
      if (age < CACHE_MAX_AGE_MS) return { json: await hit.json(), cached: true };
      await cache.delete(url);
    }
  }

  const body = await fetchTextRetrying(url);
  if (cache) {
    const headers = new Headers({
      "content-type": "application/json",
      [CACHED_AT_HEADER]: String(Date.now()),
    });
    await cache.put(url, new Response(body, { headers }));
  }
  return { json: JSON.parse(body), cached: false };
}

// GET a URL's body, with a timeout per attempt and retries (backing off) for
// what a retry can fix: timeouts, network errors, 429 and 5xx. Any other
// status (a 400 for a bad query) fails at once.
async function fetchTextRetrying(url) {
  for (let attempt = 0; ; attempt++) {
    let retryAfterMs = null;
    let error;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return await res.text();
      error = new Error(`USGS API ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw Object.assign(error, { final: true });
      const after = Number(res.headers.get("retry-after"));
      if (after > 0) retryAfterMs = after * 1000;
    } catch (err) {
      if (err.final) throw err;
      error = err.name === "TimeoutError" ? new Error("USGS API timed out") : err;
    }
    if (attempt >= RETRIES) throw error;
    await new Promise((r) => setTimeout(r, retryAfterMs ?? RETRY_BASE_MS * 2 ** attempt));
  }
}

async function openCache() {
  // Cache API is only exposed in secure contexts (https / localhost).
  if (typeof caches === "undefined") return null;
  try {
    // v1's pages are keyed by URLs nothing asks for any more.
    caches.delete("usgs-continuous-v1").catch(() => {});
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}
