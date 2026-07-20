// ====================================================================
// Loaded-dataset accessors
//
// Tiny leaf module (imports only state) so both map painting and the UI
// panels can read per-reach values without creating an import cycle.
// ====================================================================
import { state } from "../state.js";

export function valueAt(variable, row, timeIndex) {
  const m = state.data.matrices[variable];
  return m[row * state.data.nTimes + timeIndex];
}
