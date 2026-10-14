#!/usr/bin/env bun
// Builds src/data/usgsdams.json: which USGS stream gages sit just below a dam,
// and which have no dams upstream at all. Run with (needs `unzip`):
//   bun scripts/usgs-dams.js [--cache DIR]
//
// Neither fact is a field in the Water Data API.
//
// "Just below a dam" comes from each site's station description
// ("manuscript"), the LOCATION / REMARKS text the monitoring-location pages
// show, e.g.
//   LOCATION  "... on right bank, 500 ft downstream of powerhouse (dam), ..."
//   REMARKS   "Occasional regulation by Pine Hill Lake 1.7 mi upstream."
// That endpoint is one request per site and sends no CORS header, so the
// browser can't scan it; this script does, and the viewer ships the result.
//
// "No dams upstream" is GAGES-II (Falcone 2011, the basin screening CAMELS
// was drawn from): NDAMS_2009 = 0 dams of the 2009 National Inventory of Dams
// anywhere in the watershed, unless the station description now names
// regulation. Gages GAGES-II doesn't cover count only when their description
// says "no regulation" outright.
//
// --cache keeps the raw manuscripts and the GAGES-II zip so the rules below
// can be retuned without refetching (~17.5k requests, ~35 min).
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const API = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/combined-metadata/items";
const MANUSCRIPT = "https://waterdata.usgs.gov/manuscripts/";
// GAGES-II basin characteristics (ScienceBase item 631405bbd34e36012efa304a).
const GAGES_II =
  "https://www.sciencebase.gov/catalog/file/get/631405bbd34e36012efa304a?name=basinchar_and_report_sept_2011.zip";
const OUT = join(import.meta.dir, "../src/data/usgsdams.json");
const SITE_TYPES = new Set(["Stream", "Tidal stream", "Canal", "Ditch"]);
const SLICE_CUTS = ["USGS-0228", "USGS-0534", "USGS-0815", "USGS-1424", "USGS-3851"];
const CONCURRENCY = 8;
// A gage this close below a dam counts as "just below" it.
export const MAX_BELOW_MI = 5;

const cacheArg = process.argv.indexOf("--cache");
const cacheDir = cacheArg > 0 ? process.argv[cacheArg + 1] : null;
if (cacheDir) mkdirSync(cacheDir, { recursive: true });

// ---- Fetch ----------------------------------------------------------------

// The same continuous-record sites the viewer's catalog holds, streams only.
async function streamSites() {
  const bounds = [null, ...SLICE_CUTS, null];
  const sites = new Map();
  for (let i = 0; i < bounds.length - 1; i++) {
    const clauses = ["data_type = 'Continuous values'"];
    if (bounds[i]) clauses.push(`monitoring_location_id >= '${bounds[i]}'`);
    if (bounds[i + 1]) clauses.push(`monitoring_location_id < '${bounds[i + 1]}'`);
    let url = `${API}?${new URLSearchParams({
      f: "json",
      limit: "50000",
      skipGeometry: "true",
      properties: "monitoring_location_id,monitoring_location_name,site_type",
      "filter-lang": "cql-text",
      filter: clauses.join(" AND "),
    })}`;
    while (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`USGS API ${res.status}`);
      const json = await res.json();
      for (const { properties: p } of json.features) {
        if (SITE_TYPES.has(p.site_type)) sites.set(p.monitoring_location_id, p.monitoring_location_name);
      }
      url = json.links?.find((l) => l.rel === "next")?.href;
    }
  }
  return sites;
}

// { LOCATION, REMARKS, ... } for one site, {} when it has no manuscript.
async function manuscript(id) {
  const file = cacheDir && join(cacheDir, `${id}.json`);
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  let elements = {};
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(MANUSCRIPT + id);
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const els = (await res.json())?.USGS?.Manuscript?.Element ?? [];
      for (const e of [els].flat()) elements[e.name] = clean(e.info);
      break;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${id}: ${err.message}`);
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
  if (file) writeFileSync(file, JSON.stringify(elements));
  return elements;
}

// GAGES-II site number -> number of NID dams in its watershed. The CSVs are
// in a zip inside the zip.
async function gagesDams() {
  const dir = cacheDir ?? tmpdir();
  const zip = join(dir, "gagesII_basinchar.zip");
  if (!existsSync(zip)) {
    const res = await fetch(GAGES_II);
    if (!res.ok) throw new Error(`GAGES-II ${res.status}`);
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
  }
  const inner = join(dir, "gagesII_csv.zip");
  if (!existsSync(inner)) await Bun.write(inner, unzip(zip, "spreadsheets-in-csv-format.zip"));
  const dams = new Map();
  for (const table of ["conterm_hydromod_dams.txt", "AKHIPR_hydromod_dams.txt"]) {
    const [head, ...lines] = new TextDecoder("latin1").decode(unzip(inner, table)).trim().split(/\r?\n/);
    const cols = head.split(",");
    const id = cols.indexOf("STAID");
    const n = cols.indexOf("NDAMS_2009");
    for (const line of lines) {
      const f = line.split(",");
      dams.set(f[id].replace(/"/g, ""), Number(f[n]));
    }
  }
  return dams;
}

function unzip(zip, member) {
  const out = Bun.spawnSync(["unzip", "-p", zip, member]);
  if (out.exitCode !== 0) throw new Error(`unzip ${member}: ${out.stderr}`);
  return out.stdout;
}

// Manuscript text is HTML-ish: tags, entities, odd whitespace.
function clean(info) {
  return String(info ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&deg;/g, "°")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Classify -------------------------------------------------------------

// Structures whose release a gage just below is measuring. Not when the word
// is part of a road or another waterbody's name ("Silver Lake Road", "Lake
// Swamp").
const DAM = String.raw`(?:dams?|powerhouse|power ?plant|power ?station|hydro(?:electric)? (?:plant|station|project)|spillway|tailrace|outlet works|outlet structure|control structure|weir|reservoir|lake|locks? and dam)\b(?!\s+(?:road|rd|street|st|avenue|ave|drive|dr|highway|hwy|route|lane|ln|boulevard|blvd|bridge|swamp|creek|brook|river|run|branch|ditch|canal|outlet|village|city|park|estates|subdivision)\b)`;
// ...and the thing named isn't a crossing ("downstream from bridge on X Lake Road").
const NOT_DAM = /\b(?:bridge|culvert|road|rd|street|highway|hwy|route|crossing|mouth|confluence)\b/i;
const DIST = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(ft|feet|foot|mi|miles?|km|kilometers?|m|meters?|yds?|yards?)\.?`;
const UNIT_MI = { ft: 1 / 5280, feet: 1 / 5280, foot: 1 / 5280, mi: 1, mile: 1, miles: 1, km: 0.621371, kilometer: 0.621371, kilometers: 0.621371, m: 0.000621371, meter: 0.000621371, meters: 0.000621371, yd: 1 / 1760, yds: 1 / 1760, yard: 1 / 1760, yards: 1 / 1760 };

// "<dist> downstream from|of|below <...> <dam>" within one clause of the
// LOCATION text.
const BELOW_DIST = new RegExp(
  String.raw`${DIST}\s+(?:downstream|below)\s+(?:from|of)?\s*([^,;.]*?\b${DAM})`,
  "gi",
);
// Distance-free forms: "(just) below X Dam" (no figure in front), "at
// downstream side of spillway structure of X Dam", "in the tailrace".
const BELOW_NEAR = new RegExp(
  String.raw`(?:(?<!\d\s*(?:ft|feet|foot|mi|miles?|km|m|meters?|yds?|yards?)\.?\s+)\b(?:below|downstream (?:from|of))|\bdownstream (?:side|face|end|toe) of)\s+([^,;.]*?\b${DAM})|\b(?:in|at)\s+(?:the\s+)?(?:tailrace|tailwater|stilling basin|outlet works|spillway)\b`,
  "gi",
);
// Remarks that put the controlling structure right above the gage:
// "regulated by X Lake (station ...) 1.0 mi upstream".
const REGULATED_DIST = new RegExp(
  String.raw`regulat\w*([^.;]*?\b${DAM})[^.;]{0,60}?${DIST}\s+(?:upstream|above)`,
  "gi",
);
// Station names: "... BL LK JAMES ...", "... BELOW X DAM ...".
const NAME_BELOW = /\b(?:BL|BLW|BLO|BEL|BELOW)\s+(?:[A-Z.'-]+\s+){0,4}?(?:DAM|RES|RESV|RESERVOIR|LK|LAKE|POWERHOUSE|PH|PWRHSE|POWERPLANT|PP)\b|\bTAIL(?:RACE|WATER)\b/;

function toMiles(n, unit) {
  return Number(n.replace(/,/g, "")) * (UNIT_MI[unit.toLowerCase().replace(/\.$/, "")] ?? NaN);
}

// Miles from the nearest dam directly upstream (0 when the text says "just
// below" without a figure), or null when the description doesn't place one
// within MAX_BELOW_MI.
export function belowDam(name, el) {
  const location = el.LOCATION ?? "";
  const remarks = el.REMARKS ?? "";
  let best = Infinity;
  for (const m of location.matchAll(BELOW_DIST)) {
    if (!NOT_DAM.test(m[3])) best = Math.min(best, toMiles(m[1], m[2]));
  }
  for (const m of remarks.matchAll(REGULATED_DIST)) {
    if (!NOT_DAM.test(m[1])) best = Math.min(best, toMiles(m[2], m[3]));
  }
  if (best <= MAX_BELOW_MI) return round(best);
  for (const m of location.matchAll(BELOW_NEAR)) if (!(m[1] && NOT_DAM.test(m[1]))) return 0;
  if (NAME_BELOW.test(name.toUpperCase())) return 0;
  return null;
}

// What the REMARKS say about regulation upstream: "none" when they state
// there is none, "regulated" when they name any, else null (not stated).
const NO_REGULATION = /\bno (?:known |significant |appreciable |major )?(?:regulation|storage|regulating)\b|\bnot regulated\b|\bunregulated\b|\bnatural flow\b/i;
const REGULATION = /\bregulat|\b(?:storage|stored) in\b|\bcontrolled by\b|\breservoirs?\b|(?<!beaver )\bdams?\b|\bimpound/i;

export function regulation(el) {
  const remarks = el.REMARKS ?? "";
  if (!remarks) return null;
  // Strip the "no regulation" phrases first: a remark can say "No known
  // regulation." and still mention a reservoir elsewhere, which wins.
  const rest = remarks.replace(new RegExp(NO_REGULATION.source, "gi"), " ");
  if (REGULATION.test(rest)) return "regulated";
  return NO_REGULATION.test(remarks) ? "none" : null;
}

function round(mi) {
  return Math.round(mi * 100) / 100;
}

// ---- Main -----------------------------------------------------------------

if (import.meta.main) {
  const sites = await streamSites();
  const ids = [...sites.keys()];
  console.log(`${ids.length} stream sites`);
  const manuscripts = new Map();
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        manuscripts.set(id, await manuscript(id));
        if (++done % 500 === 0) console.log(`${done} / ${ids.length}`);
      }
    }),
  );

  const gages = await gagesDams();

  const below = {};
  const noDams = [];
  let described = 0;
  let fromGages = 0;
  for (const id of ids.sort()) {
    const el = manuscripts.get(id);
    const no = id.slice(id.indexOf("-") + 1);
    const reg = regulation(el);
    if (el.LOCATION || el.REMARKS) {
      described++;
      const d = belowDam(sites.get(id) ?? "", el);
      if (d != null) below[no] = d;
    }
    const nDams = gages.get(no);
    if (nDams === 0 ? reg !== "regulated" : nDams === undefined && reg === "none") {
      noDams.push(no);
      if (nDams === 0) fromGages++;
    }
  }
  const out = {
    source:
      "Below a dam: USGS station descriptions (waterdata.usgs.gov/manuscripts). " +
      "No dams upstream: GAGES-II NDAMS_2009 = 0, else the station description. " +
      "Built by scripts/usgs-dams.js",
    generated: new Date().toISOString().slice(0, 10),
    maxBelowMi: MAX_BELOW_MI,
    // site number -> miles below the dam (0 = "just below", no figure given)
    below,
    // site numbers with no dams anywhere upstream
    noDams,
  };
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log(
    `${described} described, ${Object.keys(below).length} below a dam, ` +
      `${noDams.length} with no dams upstream (${fromGages} from GAGES-II) -> ${OUT}`,
  );
}
