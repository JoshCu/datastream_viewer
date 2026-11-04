// ====================================================================
// The current timestep: the one place that changes it, and its readout.
// ====================================================================
import { state } from "../state.js";
import { TIMELINE_COLORS, isValid } from "../config.js";
import { derived } from "../data/access.js";
import { listSources } from "../data/sources.js";
import { scheduleFeatureStateUpdate } from "../map/paint.js";
import { updateHydrographCursor } from "./hydrograph.js";
import { registerTimelineTracks, syncTimeline, trackMoved } from "./timeline.js";

// Every seek goes through here — the timeline and the hydrograph. Before this
// existed each caller repeated the same repaint sequence by hand.
//
// The tooltip is deliberately *not* refreshed here: updateFeatureStates() ends
// with refreshTooltip(), so doing it again would run it twice per step.
export function setTimeIndex(i) {
  if (!state.data) return;
  const clamped = Math.max(0, Math.min(state.data.nTimes - 1, i));
  if (clamped === state.timeIndex) return;
  state.timeIndex = clamped;
  scheduleFeatureStateUpdate();
  updateHydrographCursor();
  for (const fn of timeListeners) fn(clamped);
  trackMoved("run", clamped);
}

// Other things drawn per timestep (the flood map, src/fim/) subscribe here
// rather than adding a line above. fn(timeIndex), after the repaint is
// scheduled.
const timeListeners = new Set();
export function onTimeChange(fn) {
  timeListeners.add(fn);
}

// The basin total per timestep, drawn in the run's clip on the timeline.
function runWave() {
  const dataset = state.data;
  const cache = derived(dataset, state.variable);
  if (cache.wave) return cache.wave;
  const { featureIds, nTimes } = dataset;
  const m = dataset.matrices[state.variable];
  const values = new Float64Array(nTimes);
  for (let f = 0; f < featureIds.length; f++) {
    const base = f * nTimes;
    for (let t = 0; t < nTimes; t++) {
      const v = m[base + t];
      if (isValid(v)) values[t] += v;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  cache.wave = { values, min, max };
  return cache.wave;
}

export function setupRunTimeline() {
  registerTimelineTracks(() => {
    const data = state.data;
    if (!data) return [];
    const source = listSources().find((s) => s.dataset === data);
    return [
      {
        key: "run",
        label: data.isDiff ? "Diff" : "Run",
        detail: (data.isDiff ? data.diffLabel : source?.label) ?? "Run",
        color: TIMELINE_COLORS.run,
        times: data.time,
        relative: !data.timeAbsolute,
        index: () => state.timeIndex,
        seek: setTimeIndex,
        panel: "dataPanel",
        wave: runWave,
      },
    ];
  });
}

// Reaction to the active run changing. Registered in map/init.js, after the
// paint: a run the playhead is partway through seeks straight away.
export function syncTimeToDataset({ data }) {
  syncTimeline();
  if (data) updateHydrographCursor();
}
