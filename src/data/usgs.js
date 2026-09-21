// ====================================================================
// USGS Water Data OGC API client: continuous discharge for one gage over
// a time window, with a two-level cache so re-clicking a gage (or reloading
// the page) doesn't hit the API again.
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
const nameMemo = new Map(); // site -> Promise<string|null>

// Official station name for a USGS site number (null when unknown). Memoised
// and Cache-API backed like the observations, so hovering never re-queries.
export function fetchGageName(site) {
  if (!nameMemo.has(site)) {
    const params = new URLSearchParams({
      id: `USGS-${site}`,
      properties: "monitoring_location_name",
      skipGeometry: "true",
      f: "json",
    });
    const url = `${USGS_API}/collections/monitoring-locations/items?${params}`;
    const p = fetchJsonCached(url)
      .then(({ json }) => json.features?.[0]?.properties?.monitoring_location_name ?? null)
      .catch((err) => {
        nameMemo.delete(site);
        throw err;
      });
    nameMemo.set(site, p);
  }
  return nameMemo.get(site);
}

// Fetch discharge observations for a USGS site number over [startMs, endMs].
// Resolves to { site, times: Float64Array (epoch ms), values: Float32Array
// (m³/s), units, fromCache } with points sorted by time.
export function fetchGageFlow(site, startMs, endMs) {
  const url = itemsUrl(site, startMs, endMs);
  if (!seriesMemo.has(url)) {
    const p = loadSeries(site, url).catch((err) => {
      seriesMemo.delete(url); // don't memoise failures
      throw err;
    });
    seriesMemo.set(url, p);
  }
  return seriesMemo.get(url);
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
  const points = [];
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
      points.push([t, v]);
    }
    url = (json.links || []).find((l) => l.rel === "next")?.href;
  }

  points.sort((a, b) => a[0] - b[0]);
  const times = new Float64Array(points.length);
  const values = new Float32Array(points.length);
  // The API reports discharge in ft³/s; convert to match t-route's m³/s.
  const toCms = /ft/.test(units || "") ? CFS_TO_CMS : 1;
  points.forEach(([t, v], i) => {
    times[i] = t;
    values[i] = v * toCms;
  });
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
