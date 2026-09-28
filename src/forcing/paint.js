// ====================================================================
// Catchment painting for the loaded forcing run.
//
// Same split as the flowpath results (map/paint.js): the fill-color
// expression is set once per (variable, scale, bounds) and reads
// ["feature-state", "value"]; changing the forcing timestep only rewrites
// feature-state, for just the catchments on screen (map/statepainter.js).
// Feature-state is per source, so it can't collide with the flowpaths'.
// ====================================================================
import { forcingState, map } from "../state.js";
import { DIVIDE_FEATURE, FORCING_LAYER, NO_DATA_COLOR } from "../config.js";
import { resultColorExpression } from "../color/expressions.js";
import { createStatePainter } from "../map/statepainter.js";
import { emitForcingChange } from "./store.js";

const painter = createStatePainter({
  layer: FORCING_LAYER,
  feature: DIVIDE_FEATURE,
  lookup: () => {
    const run = forcingState.run;
    const variable = forcingState.variable;
    if (!run || !variable) return null;
    const t = forcingState.timeIndex;
    const n = run.nTimes;
    const m = run.matrices[variable];
    return {
      index: run.index,
      key: variable + ":" + t,
      value: (row) => m[row * n + t],
    };
  },
});

export const scheduleForcingPaint = painter.schedule;
export const forcingTileLoaded = painter.tileLoaded;

// The camera moved: requery the on-screen catchments once it settles.
export function invalidateForcingView() {
  painter.markViewDirty();
  painter.schedule();
}

// (Re)apply the colour expression — after a variable/scale change, and after
// every load batch, since bounds grow as rows arrive — and repaint.
export function applyForcingPaint() {
  const { run, variable, scale } = forcingState;
  if (!map.getLayer(FORCING_LAYER)) return;
  if (!run || !variable) {
    map.setPaintProperty(FORCING_LAYER, "fill-color", NO_DATA_COLOR);
    return;
  }
  map.setPaintProperty(FORCING_LAYER, "fill-color", resultColorExpression(run, variable, scale));
  painter.invalidate();
  painter.markViewDirty();
  painter.schedule();
}

// Drop the run's colours. Feature-state is cleared too: a later run that
// lacks some catchment must not inherit this one's value for it.
export function clearForcingPaint() {
  painter.reset();
  if (!map.getLayer(FORCING_LAYER)) return;
  map.removeFeatureState({ source: DIVIDE_FEATURE.source, sourceLayer: DIVIDE_FEATURE.sourceLayer });
  map.setPaintProperty(FORCING_LAYER, "fill-color", NO_DATA_COLOR);
}

// The only way to change the forcing timestep (the forcing counterpart of
// ui/time.js's setTimeIndex): repaint, then tell the panel and plot.
export function setForcingTimeIndex(i) {
  const run = forcingState.run;
  if (!run) return;
  const clamped = Math.max(0, Math.min(run.nTimes - 1, i));
  if (clamped === forcingState.timeIndex) return;
  forcingState.timeIndex = clamped;
  painter.schedule();
  emitForcingChange("time");
}
