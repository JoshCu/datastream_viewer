// ====================================================================
// USGS site catalog (worker-side, pure): every monitoring location with a
// continuous time series, with what it observes and over which period.
//
// combined-metadata is the one collection that joins a time series to its
// location (name, coordinates, site type), so a single filtered query gives
// everything — ~70k series at ~27k sites, ~6 MB gzipped. Its pages are
// cursor-chained, so it's split into id ranges fetched in parallel (~5 s
// cold vs ~12 s as one chain). POST/CQL-JSON is blocked; cql-text on GET
// works.
//
// The name helpers at the bottom are shared with the main thread's search
// (data/usgscatalog.js), so both sides normalize names the same way.
// ====================================================================
import { USGS_API, USGS_OBS_TYPES } from "../../config.js";

// Range boundaries on monitoring_location_id, picked so each slice is ~12k
// series. They only balance the slices: ids outside them still land in the
// first or last range, so a stale cut can't drop sites.
const SLICE_CUTS = ["USGS-0228", "USGS-0534", "USGS-0815", "USGS-1424", "USGS-3851"];
const PAGE_LIMIT = 50000;
const MAX_PAGES = 10; // per slice; one page each today
const PROPS = [
  "monitoring_location_id",
  "monitoring_location_name",
  "site_type",
  "state_code",
  "drainage_area",
  "parameter_code",
  "parameter_name",
  "unit_of_measure",
  "begin",
  "end",
].join(",");

// FIPS state code -> postal abbreviation, for labelling river groups.
const STATE_ABBR = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT",
  "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
  "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
  "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
  "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV",
  "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};

// Which USGS_OBS_TYPES entry a parameter belongs to (its index).
export function obsTypeOf(paramName) {
  const name = paramName || "";
  return USGS_OBS_TYPES.findIndex((t) => t.match.test(name));
}

// Fetch and aggregate the whole catalog. Resolves to
//   { fetchedAt, params: [{ code, name, units, type }],
//     sites: [{ id, name, siteType, state, lon, lat, area,
//               series: [[paramIndex, beginMs, endMs], ...] }] }
// with one series entry per (site, parameter): sensor swaps and sublocations
// are merged into one span.
export async function fetchUsgsCatalog() {
  const bounds = [null, ...SLICE_CUTS, null];
  const slices = await Promise.all(
    bounds.slice(0, -1).map((lo, i) => fetchSlice(lo, bounds[i + 1])),
  );
  return buildCatalog(slices);
}

async function fetchSlice(lo, hi) {
  const clauses = ["data_type = 'Continuous values'"];
  if (lo) clauses.push(`monitoring_location_id >= '${lo}'`);
  if (hi) clauses.push(`monitoring_location_id < '${hi}'`);
  let url = `${USGS_API}/collections/combined-metadata/items?${new URLSearchParams({
    f: "json",
    limit: String(PAGE_LIMIT),
    properties: PROPS,
    "filter-lang": "cql-text",
    filter: clauses.join(" AND "),
  })}`;
  const features = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`USGS API ${res.status}`);
    const json = await res.json();
    for (const f of json.features || []) features.push(f);
    url = (json.links || []).find((l) => l.rel === "next")?.href;
  }
  return features;
}

function buildCatalog(slices) {
  const params = [];
  const paramIndex = new Map(); // code -> index into params
  const sites = new Map(); // id -> site
  const spans = new Map(); // `${id}|${p}` -> series entry, for merging

  for (const features of slices) {
    for (const f of features) {
      const p = f.properties;
      const id = p.monitoring_location_id;
      const xy = f.geometry?.coordinates;
      if (!id || !p.parameter_code || !xy) continue;

      let pi = paramIndex.get(p.parameter_code);
      if (pi === undefined) {
        pi = params.length;
        paramIndex.set(p.parameter_code, pi);
        params.push({
          code: p.parameter_code,
          name: p.parameter_name || p.parameter_code,
          units: p.unit_of_measure || "",
          type: obsTypeOf(p.parameter_name),
        });
      }

      let site = sites.get(id);
      if (!site) {
        site = {
          id,
          name: p.monitoring_location_name || id,
          siteType: p.site_type || null,
          state: STATE_ABBR[p.state_code] || "",
          lon: xy[0],
          lat: xy[1],
          area: typeof p.drainage_area === "number" ? p.drainage_area : null,
          series: [],
        };
        sites.set(id, site);
      }

      const begin = Date.parse(p.begin);
      const end = Date.parse(p.end);
      const key = `${id}|${pi}`;
      const span = spans.get(key);
      if (span) {
        if (begin < span[1] || Number.isNaN(span[1])) span[1] = begin;
        if (end > span[2] || Number.isNaN(span[2])) span[2] = end;
      } else {
        const entry = [pi, begin, end];
        spans.set(key, entry);
        site.series.push(entry);
      }
    }
  }
  // NaN doesn't survive JSON-ish expectations downstream; use null.
  for (const span of spans.values()) {
    if (Number.isNaN(span[1])) span[1] = null;
    if (Number.isNaN(span[2])) span[2] = null;
  }
  return { fetchedAt: Date.now(), params, sites: [...sites.values()] };
}

// ---- Name normalization (shared with the main thread) -------------------

// USGS station-name abbreviations, expanded so "TOMBIGBEE R" and "Tombigbee
// River" read the same.
const ABBREV = {
  R: "RIVER", RV: "RIVER", RIV: "RIVER",
  CR: "CREEK", CK: "CREEK", CRK: "CREEK", C: "CREEK",
  BR: "BRANCH", BRN: "BRANCH", BK: "BROOK",
  NB: "NORTH BRANCH", SB: "SOUTH BRANCH", EB: "EAST BRANCH", WB: "WEST BRANCH", MB: "MIDDLE BRANCH",
  FK: "FORK", TR: "TRIBUTARY", TRIB: "TRIBUTARY",
  LK: "LAKE", RES: "RESERVOIR", RESV: "RESERVOIR",
  BYU: "BAYOU", CNL: "CANAL", SL: "SLOUGH", SLO: "SLOUGH",
  DIV: "DIVERSION", DR: "DRAIN", BRK: "BROOK",
  N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST",
  NO: "NORTH", SO: "SOUTH", M: "MIDDLE", MID: "MIDDLE",
  NF: "NORTH FORK", SF: "SOUTH FORK", EF: "EAST FORK", WF: "WEST FORK", MF: "MIDDLE FORK",
  L: "LITTLE", LTL: "LITTLE", LIT: "LITTLE",
  ST: "SAINT", STE: "SAINTE", FT: "FORT", MT: "MOUNT", MTN: "MOUNTAIN",
  SPG: "SPRING", SPGS: "SPRINGS", HBR: "HARBOR", PT: "POINT",
};

// Words that end the waterbody part of a station name ("X RIVER AT Y").
const LOCATORS = new Set([
  "AT", "NEAR", "NR", "ABOVE", "ABV", "AB", "BELOW", "BLW", "BL", "BLO", "BEL",
  "UPSTREAM", "DOWNSTREAM", "US", "DS", "IN", "ON", "OFF", "AND", "TO",
]);

// A waterbody part has to name one, or it's not worth grouping by ("15N 20E
// 23ABC1", lake-gage station codes, etc.).
const WATERBODY = /\b(RIVER|CREEK|BRANCH|FORK|RUN|BROOK|LAKE|RESERVOIR|BAYOU|CANAL|SLOUGH|DRAIN|DITCH|WASH|STREAM|KILL|SPRINGS?|BAY|HARBOR|INLET|SOUND|CHANNEL|TRIBUTARY|POND|ARROYO|DRAW|GULCH|PRONG|DIVERSION|ESTUARY|LAGOON|OUTLET|FALLS|SWAMP|HOLLOW|DRAFT)\b/;
// ...and something besides these, or "UNNAMED TRIBUTARY" would group a
// hundred unrelated streams.
const GENERIC = new Set([
  "TRIBUTARY", "UNNAMED", "UT", "BRANCH", "FORK",
  "NORTH", "SOUTH", "EAST", "WEST", "MIDDLE", "THE", "OF", "TO",
]);

// Uppercase words with abbreviations expanded: "Tombigbee R. nr Coffeeville"
// -> ["TOMBIGBEE", "RIVER", "NR", "COFFEEVILLE"]. "@" is kept as a word.
export function nameWords(text) {
  const words = String(text || "")
    .toUpperCase()
    .replace(/@/g, " AT ")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  return words.flatMap((w) => (ABBREV[w] ? ABBREV[w].split(" ") : [w]));
}

// Letters and digits only: "TOM BIGBEE" and "TOMBIGBEE" compare equal.
export function compact(words) {
  return words.join("");
}

// The waterbody a station is on, normalized ("TOMBIGBEE RIVER"), or null.
// It's the words before the first locator ("... AT ...", "... NR ...").
// A name with no locator before its first comma ("SOUCOOK RIVER, AT ...")
// takes that whole first part.
export function waterbodyOf(name) {
  const parts = String(name || "").split(",");
  const words = nameWords(parts[0]);
  let stop = words.findIndex((w, i) => i > 0 && LOCATORS.has(w));
  if (stop < 0) stop = parts.length > 1 ? words.length : 0;
  if (stop <= 0) return null;
  const head = words.slice(0, stop);
  const body = head.join(" ");
  if (!WATERBODY.test(body) || head.every((w) => GENERIC.has(w))) return null;
  return body;
}
