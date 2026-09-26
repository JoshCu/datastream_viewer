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

const CACHE_NAME = "usgs-continuous-v1";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = "x-cached-at";
const MAX_PAGES = 20; // 50k rows/page; 15-min data is ~35k rows/year

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
// verticalDatum, series: [{ code, name, units, beginMs, endMs }], flow }.
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
    { id: `USGS-${site}`, properties: SITE_PROPS, skipGeometry: "true", f: "json" },
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
      .then(({ json }) => json.features?.[0]?.properties ?? null)
      .catch(() => null),
    fetchJsonCached(seriesUrl)
      .then(({ json }) => json.features ?? [])
      .catch(() => null),
  ]);
  if (!loc && !features) throw new Error("USGS metadata unavailable");

  const series = summarizeSeries(features || []);
  return {
    site,
    name: loc?.monitoring_location_name ?? null,
    siteType: loc?.site_type ?? null,
    drainageArea: numberOrNull(loc?.drainage_area),
    altitude: numberOrNull(loc?.altitude),
    verticalDatum: loc?.vertical_datum ?? null,
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
// (m³/s), units, fromCache } with points sorted by time.
export function fetchGageFlow(site, startMs, endMs) {
  const url = itemsUrl(site, startMs, endMs);
  return memo(seriesMemo, url, () => loadSeries(site, url));
}

function itemsUrl(site, startMs, endMs) {
  const params = new URLSearchParams({
    monitoring_location_id: `USGS-${site}`,
    parameter_code: USGS_FLOW_PARAM,
    time: `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`,
    skipGeometry: "true",
    limit: "50000",
    f: "json",
  });
  return `${USGS_API}/collections/continuous/items?${params}`;
}

async function loadSeries(site, firstUrl) {
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
  return { site, times, values, units: "m³/s", rawUnits: units, fromCache };
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

  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS API ${res.status}`);
  const body = await res.text();
  if (cache) {
    const headers = new Headers({
      "content-type": "application/json",
      [CACHED_AT_HEADER]: String(Date.now()),
    });
    await cache.put(url, new Response(body, { headers }));
  }
  return { json: JSON.parse(body), cached: false };
}

async function openCache() {
  // Cache API is only exposed in secure contexts (https / localhost).
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}
