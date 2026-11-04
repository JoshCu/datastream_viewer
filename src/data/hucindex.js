// ====================================================================
// Hydrologic units by code or name, for the search box. huc.pmtiles can only be
// read by place, so scripts/huc-index.js builds a list offline into
// hucindex.parquet on S3, read through the parse pool the first time search
// opens (data/workers/hucindex.js). A unit's bounds are read when it's picked.
// ====================================================================
import { HUC_LEVELS } from "../config.js";
import { runTask } from "./loader.js";
import { matchScore } from "./usgscatalog.js";
import { compact, nameWords } from "./workers/usgscatalog.js";

const LEVEL_BY_LENGTH = new Map(HUC_LEVELS.map((level) => [Number(level.key.slice(3)), level]));
const MAX_RESULTS = 6;
const PARSE_SLICE = 4000; // rows between yields: ~1 s for them all otherwise

let units = null;
let loading = null;
let loadError = null;

function makeUnit(huc, name, row) {
  const words = nameWords(name);
  return {
    huc,
    name,
    row,
    level: LEVEL_BY_LENGTH.get(huc.length),
    bounds: null, // hucBounds() fills it in
    words,
    compactName: compact(words),
  };
}

// Safe to call repeatedly. A failed load can be retried by calling it again.
export function loadHucIndex() {
  if (loading) return loading;
  loadError = null;
  loading = runTask({ type: "hucIndex" })
    .then(async ({ huc, name }) => {
      const parsed = [];
      for (let i = 0; i < huc.length; i += PARSE_SLICE) {
        const end = Math.min(i + PARSE_SLICE, huc.length);
        for (let row = i; row < end; row++) parsed.push(makeUnit(huc[row], name[row], row));
        await new Promise((resolve) => setTimeout(resolve));
      }
      units = parsed;
    })
    .catch((err) => {
      loading = null;
      loadError = err;
      throw err;
    });
  return loading;
}

export const hucIndexLoaded = () => units !== null;
export const hucIndexError = () => loadError;

// A unit's [west, south, east, north], read once.
export async function hucBounds(unit) {
  unit.bounds ??= await runTask({ type: "hucIndexRow", row: unit.row });
  return unit.bounds;
}

// A query that says it's after a HUC: "huc 1027", "huc8 10270104", "HUC-12
// wakarusa", "huc". { query, level }, level being a key of HUC_LEVELS or null;
// null for anything else. "huc 10" and "huc 12" are regions by those codes, while
// "huc10" and "huc 8" name a level and are waiting for the rest.
export function parseHucQuery(text) {
  const m = /^\s*huc(?:([-_ ]?)(2|4|6|8|10|12)(?![0-9]))?[-_ ]*(.*?)\s*$/i.exec(text);
  if (!m) return null;
  const [, separator, size, rest] = m;
  // "huckleberry": a word starting with the letters isn't asking for a HUC.
  if (!size && /^[a-z]/i.test(text.trim().slice(3))) return null;
  if (separator && size?.length === 2 && !rest) return { query: size, level: null };
  return { query: rest, level: size ? `huc${size}` : null };
}

function byCoarsestThenCode(a, b) {
  return a.huc.length - b.huc.length || (a.huc < b.huc ? -1 : 1);
}

// Units matching free text, best first: by code prefix for two or more digits,
// else by name, optionally at one level.
export function searchHucs(text, { level = null } = {}) {
  if (!units) return [];
  const atLevel = (u) => !level || u.level.key === level;
  const query = text.trim();
  if (/^\d+$/.test(query)) {
    if (query.length < 2 || query.length > 12) return [];
    return units
      .filter((u) => u.huc.startsWith(query) && atLevel(u))
      .sort(byCoarsestThenCode)
      .slice(0, MAX_RESULTS);
  }
  const qWords = nameWords(query);
  const qCompact = compact(qWords);
  if (qCompact.length < 2) return [];
  const matching = (fuzzy) => {
    const hits = [];
    for (const unit of units) {
      if (!unit.compactName || !atLevel(unit)) continue;
      const score = matchScore(qWords, qCompact, unit.words, unit.compactName, fuzzy);
      if (!score) continue;
      // Whole words first: "Upper Kansas" before "Lower Arkansas" for "kansas".
      const wordStart = qWords.every((q) => unit.words.some((w) => w.startsWith(q)));
      hits.push({ unit, score: score + (wordStart ? 1 : 0) });
    }
    return hits;
  };
  // The typo test only when the plain ones leave room in the list.
  let hits = matching(false);
  if (hits.length < MAX_RESULTS) hits = matching(true);
  hits.sort((a, b) => b.score - a.score || byCoarsestThenCode(a.unit, b.unit));
  return hits.slice(0, MAX_RESULTS).map((hit) => hit.unit);
}
