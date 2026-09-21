// ====================================================================
// Gage layer visibility: only gages sitting on a reach in the loaded run
// ====================================================================
import { state, map } from "../state.js";
import { HIDDEN_FILTER, GAGE_LAYER, GAGE_GLOW_LAYER } from "../config.js";

const LAYERS = [GAGE_LAYER, GAGE_GLOW_LAYER];

// Show the gages whose flowpath (`id` property) is in the loaded dataset, or
// hide the layer entirely when nothing is loaded. `match` is used rather than
// `in` because MapLibre compiles its label list into a hash lookup, which
// keeps a CONUS-sized id list cheap to evaluate per feature.
export function updateGageFilter() {
  if (!map.getLayer(GAGE_LAYER)) return;
  // index keys are de-duplicated; match rejects repeated labels.
  const filter = state.data
    ? ["match", ["get", "id"], Array.from(state.data.index.keys()), true, false]
    : HIDDEN_FILTER;
  for (const layer of LAYERS) map.setFilter(layer, filter);
}
