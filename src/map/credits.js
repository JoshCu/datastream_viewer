// ====================================================================
// The map's attribution: MapLibre's own control (which lists the style's
// sources), plus a credit for each overlay on show. Those overlays aren't all
// sources that carry an attribution, and the control has no API to change its
// text, so a change swaps in a new control; that also shows it expanded, so a
// new credit is seen.
// ====================================================================
import { map } from "../state.js";

const MAPLIBRE = '<a href="https://maplibre.org/" target="_blank">MapLibre</a>';

const credits = new Map(); // owner -> html
let control = null;

export function syncCredits() {
  if (control) map.removeControl(control);
  control = new maplibregl.AttributionControl({
    compact: true,
    customAttribution: [...credits.values(), MAPLIBRE],
  });
  map.addControl(control);
}

// Show `credit` { short, url } for `owner` (null removes it).
export function setMapCredit(owner, credit) {
  const html = credit
    ? `<a href="${credit.url}" target="_blank" rel="noopener">${credit.short}</a>`
    : null;
  if ((credits.get(owner) ?? null) === html) return;
  if (html) credits.set(owner, html);
  else credits.delete(owner);
  syncCredits();
}
