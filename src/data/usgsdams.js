// ====================================================================
// Dams at USGS stream gages: which sit just below one, and which have none
// anywhere upstream. Neither is an API field. "Below a dam" comes from each
// site's station description (its LOCATION / REMARKS text), which is one
// request per site with no CORS header; "no dams" from GAGES-II's count of
// NID dams in the watershed. scripts/usgs-dams.js builds usgsdams.json from
// both offline.
// Keyed by site number without the agency prefix (catalog `site.no`).
// ====================================================================
import dams from "./usgsdams.json" with { type: "json" };

const noDams = new Set(dams.noDams);

// The furthest a gage can be below a dam and still be listed.
export const MAX_BELOW_MI = dams.maxBelowMi;

// Miles below the dam directly upstream (0 = "just below" with no figure
// given), or null when the description places none within MAX_BELOW_MI.
export function damBelowMi(no) {
  return dams.below[no] ?? null;
}

// No dams anywhere in the site's watershed.
export function hasNoDams(no) {
  return noDams.has(no);
}
