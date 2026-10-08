// ====================================================================
// USGS site catalog (main thread): every monitoring location with a
// continuous time series, for the gage layer (map/usgssites.js), its panel
// (ui/usgspanel.js), the gage tooltips, and the search box (map/search.js).
//
// The worker fetches it (data/workers/usgscatalog.js, ~6 MB, ~5 s); it's kept
// in IndexedDB and served from there on later visits, refreshed in the
// background once older than USGS_CATALOG_TTL_MS. Installing it builds:
//   - per-site observation-type bitmasks (all-time and active), the
//     colour/filter keys of the map layer
//   - normalized names for fuzzy search
//   - river groups: sites sharing a waterbody name ("TOMBIGBEE RIVER"),
//     split into spatial clusters so the many "MILL CREEK"s stay apart
// ====================================================================
import { runTask } from "./loader.js";
import {
  USGS_CATALOG_TTL_MS,
  USGS_ACTIVE_WINDOW_MS,
  USGS_OBS_TYPES,
} from "../config.js";
import { nameWords, compact, waterbodyOf } from "./workers/usgscatalog.js";

const DB_NAME = "datastream-viewer-usgs";
const STORE = "catalog";
// Bump when the worker's output shape changes, so an old cache is ignored.
const CACHE_KEY = "combined-metadata-v1";

// Sites on one named waterbody further apart than this (and not chained by
// sites in between) are different streams. Big rivers are gaged sparsely, so
// the reach grows with drainage area: ~500 km on the lower Mississippi, which
// keeps it one group while the dozens of "MILL CREEK"s stay apart.
const GROUP_LINK_KM = 100;
const GROUP_LINK_PER_SQRT_MI2 = 0.5;

let catalog = null; // installed catalog, see install()
let loading = null; // in-flight load/refresh promise
let status = { kind: "idle", text: "" };
const listeners = new Set();

// fn(catalog, status) on every install or status change.
export function onCatalogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(catalog, status);
}

function setStatus(kind, text) {
  status = { kind, text };
  emit();
}

export function getCatalog() {
  return catalog;
}

export function catalogStatus() {
  return status;
}

// ---- Load / cache ---------------------------------------------------------

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      // No IndexedDB (private mode, blocked): just don't persist.
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

async function dbGet() {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(CACHE_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function dbPut(raw) {
  const db = await openDb();
  if (db) db.transaction(STORE, "readwrite").objectStore(STORE).put(raw, CACHE_KEY);
}

// Show the cached catalog straight away if there is one; fetch a fresh one
// when there isn't, it's stale, or `force`. A failed refresh keeps the stale
// copy on screen.
export function loadUsgsCatalog({ force = false } = {}) {
  if (loading) return loading;
  loading = (async () => {
    if (!catalog) {
      const cached = await dbGet();
      if (cached) install(cached);
    }
    const fresh = catalog && Date.now() - catalog.fetchedAt < USGS_CATALOG_TTL_MS;
    if (fresh && !force) {
      setStatus("loaded", readyText());
      return catalog;
    }
    setStatus("loading", catalog ? "Refreshing the USGS site list…" : "Loading the USGS site list…");
    try {
      const raw = await runTask({ type: "usgsCatalog" });
      dbPut(raw);
      install(raw);
      setStatus("loaded", readyText());
    } catch (err) {
      console.error("USGS catalog load failed:", err);
      if (catalog) setStatus("loaded", `${readyText()} (refresh failed)`);
      else setStatus("error", `USGS site list unavailable: ${err.message}`);
    }
    return catalog;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function readyText() {
  const hours = (Date.now() - catalog.fetchedAt) / 3.6e6;
  const age =
    hours < 1 ? "just now" : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
  return `${catalog.sites.length.toLocaleString()} sites · updated ${age}`;
}

// ---- Install: derive everything the map and search need -------------------

function install(raw) {
  const activeSince = raw.fetchedAt - USGS_ACTIVE_WINDOW_MS;
  const sites = raw.sites.map((s) => {
    let mask = 0;
    let activeMask = 0;
    for (const [p, , end] of s.series) {
      const bit = 1 << raw.params[p].type;
      mask |= bit;
      if (end != null && end >= activeSince) activeMask |= bit;
    }
    const words = nameWords(s.name);
    return {
      ...s,
      // The site number without its agency prefix ("01013500").
      no: s.id.slice(s.id.indexOf("-") + 1),
      mask,
      activeMask,
      active: activeMask !== 0,
      words,
      compactName: compact(words),
      waterbody: waterbodyOf(s.name),
      group: null,
    };
  });
  catalog = {
    fetchedAt: raw.fetchedAt,
    params: raw.params,
    sites,
    byId: new Map(sites.map((s) => [s.id, s])),
    groups: buildGroups(sites),
  };
}

function buildGroups(sites) {
  const byBody = new Map();
  for (const s of sites) {
    if (!s.waterbody) continue;
    let list = byBody.get(s.waterbody);
    if (!list) byBody.set(s.waterbody, (list = []));
    list.push(s);
  }
  const groups = [];
  for (const [body, list] of byBody) {
    if (list.length < 2) continue;
    for (const members of clusters(list)) {
      if (members.length < 2) continue;
      // Upstream to downstream, as far as drainage area tells.
      members.sort((a, b) => (a.area ?? Infinity) - (b.area ?? Infinity));
      const words = body.split(" ");
      const group = {
        key: `${body}#${groups.length}`,
        label: titleCase(body),
        words,
        compactName: compact(words),
        states: topStates(members),
        sites: members,
      };
      for (const s of members) s.group = group;
      groups.push(group);
    }
  }
  return groups;
}

function linkKm(a, b) {
  const area = Math.max(a.area ?? 0, b.area ?? 0);
  return Math.max(GROUP_LINK_KM, GROUP_LINK_PER_SQRT_MI2 * Math.sqrt(area));
}

// Single-linkage clusters (union-find; groups are at most a few hundred
// sites, so the pairwise pass is cheap).
function clusters(list) {
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      if (find(i) !== find(j) && distanceKm(a, b) <= linkKm(a, b)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const out = new Map();
  list.forEach((s, i) => {
    const root = find(i);
    if (!out.has(root)) out.set(root, []);
    out.get(root).push(s);
  });
  return out.values();
}

function distanceKm(a, b) {
  const kx = 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 110.57);
}

function topStates(members) {
  const counts = new Map();
  for (const s of members) if (s.state) counts.set(s.state, (counts.get(s.state) || 0) + 1);
  const states = [...counts].sort((a, b) => b[1] - a[1]).map(([st]) => st);
  return states.length > 3 ? `${states.slice(0, 3).join(", ")} +${states.length - 3}` : states.join(", ");
}

function titleCase(text) {
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ---- Per-site views -------------------------------------------------------

// The observation types a site has (indices into USGS_OBS_TYPES), in
// priority order; `active` limits it to ones reporting recently.
export function siteTypes(site, active = false) {
  const mask = active ? site.activeMask : site.mask;
  return USGS_OBS_TYPES.flatMap((_, i) => (mask & (1 << i) ? [i] : []));
}

// The site in the same shape fetchGageMeta() resolves to (data/usgs.js), so
// the gage tooltip renders either: { site, name, siteType, drainageArea,
// series: [{ code, name, units, beginMs, endMs }], flow, types }.
export function catalogMeta(id) {
  const s = catalog?.byId.get(id);
  if (!s) return null;
  const series = s.series
    .map(([p, beginMs, endMs]) => ({ ...catalog.params[p], beginMs, endMs }))
    .sort((a, b) => (b.endMs ?? 0) - (a.endMs ?? 0));
  return {
    site: s.no,
    name: s.name,
    siteType: s.siteType,
    drainageArea: s.area,
    altitude: null,
    verticalDatum: null,
    series,
    flow: series.find((x) => x.type === 0 && /^discharge$/i.test(x.name)) ??
      series.find((x) => x.type === 0) ??
      null,
    types: siteTypes(s),
    active: s.active,
  };
}

// ---- Search ---------------------------------------------------------------

// Share of the query's trigrams found in `text`: catches typos the
// substring tests miss ("TOMBIGBE", "TOMBIGBY").
function trigramScore(q, text) {
  if (q.length < 4) return 0;
  let hits = 0;
  const n = q.length - 2;
  for (let i = 0; i < n; i++) if (text.includes(q.slice(i, i + 3))) hits++;
  return hits / n;
}

// How well normalized query words match a name (0 = not at all). Spaces are
// ignored for the main test, so "TOM BIGBEE" finds "TOMBIGBEE RIVER".
function matchScore(qWords, qCompact, words, compactName) {
  const at = compactName.indexOf(qCompact);
  if (at === 0) return 4;
  if (at > 0) return 3;
  // Every query word starts a name word; better when the first leads.
  if (qWords.every((q) => words.some((w) => w.startsWith(q)))) {
    return words[0].startsWith(qWords[0]) ? 2.5 : 2;
  }
  const tri = trigramScore(qCompact, compactName);
  return tri >= 0.7 ? tri : 0;
}

// Sites and river groups matching free text, best first:
//   { groups: [group], sites: [site] }
// A query of digits (or "USGS-<digits>") matches site numbers by prefix.
export function searchCatalog(text, { maxGroups = 6, maxSites = 12 } = {}) {
  if (!catalog) return { groups: [], sites: [] };
  const idQuery = /^\s*(?:[A-Za-z]{2,5}-)?(\d{3,15})\s*$/.exec(text);
  if (idQuery) {
    const digits = idQuery[1];
    const sites = catalog.sites.filter((s) => s.no.startsWith(digits));
    sites.sort((a, b) => a.no.length - b.no.length || rankSite(a, b));
    return { groups: [], sites: sites.slice(0, maxSites) };
  }

  const qWords = nameWords(text);
  const qCompact = compact(qWords);
  if (qCompact.length < 2) return { groups: [], sites: [] };

  const groups = [];
  for (const g of catalog.groups) {
    const score = matchScore(qWords, qCompact, g.words, g.compactName);
    if (score) groups.push({ g, score });
  }
  groups.sort((a, b) => b.score - a.score || b.g.sites.length - a.g.sites.length);

  const sites = [];
  for (const s of catalog.sites) {
    const score = matchScore(qWords, qCompact, s.words, s.compactName);
    if (score) sites.push({ s, score });
  }
  sites.sort((a, b) => b.score - a.score || rankSite(a.s, b.s));

  return {
    groups: groups.slice(0, maxGroups).map((x) => x.g),
    sites: sites.slice(0, maxSites).map((x) => x.s),
  };
}

// Tie-break: reporting sites, then discharge gages, then bigger basins.
function rankSite(a, b) {
  return (
    b.active - a.active ||
    (b.mask & 1) - (a.mask & 1) ||
    (b.area ?? 0) - (a.area ?? 0)
  );
}
