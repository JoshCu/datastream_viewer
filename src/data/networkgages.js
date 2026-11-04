// ====================================================================
// Which USGS sites sit on a reach of each routing network. The browser only
// sees this tile by tile, so scripts/network-gages.js builds the whole list
// into networkgages.json offline.
// Keyed by site number without the agency prefix (catalog `site.no`).
// ====================================================================
import gages from "./networkgages.json" with { type: "json" };

const BITS = { nextgen: 1, nwm: 2 };

// `network` is "nextgen" or "nwm".
export function isOnNetwork(no, network) {
  return ((gages.sites[no] ?? 0) & BITS[network]) !== 0;
}
