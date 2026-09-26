// ====================================================================
// Registry of every loaded run the hydrograph can plot side by side.
//
// state.data is only the run painted on the map; this holds all the
// normalized datasets currently resident (each uploaded file plus the latest
// S3 load), so clicking a reach can chart it from every run at once. Diffs
// are never registered — their values aren't a flow/velocity/depth.
//
// Each source keeps a color slot for as long as it's registered, so a run
// keeps its hydrograph color as other runs come and go. Imports nothing.
// ====================================================================

const sources = new Map(); // key -> { key, label, dataset, slot }
const listeners = new Set();

export function registerSource(key, label, dataset) {
  const prev = sources.get(key);
  sources.set(key, { key, label, dataset, slot: prev ? prev.slot : freeSlot() });
  emit();
}

// Relabel a registered source (a nickname given in the upload list). No-op
// for a key that isn't loaded yet; it picks the label up when it registers.
export function renameSource(key, label) {
  const src = sources.get(key);
  if (!src || src.label === label) return;
  src.label = label;
  emit();
}

export function unregisterSource(key) {
  if (sources.delete(key)) emit();
}

export function listSources() {
  return [...sources.values()];
}

export function onSourcesChange(fn) {
  listeners.add(fn);
}

// ---- The active dataset (the one painted on the map) -----------------
//
// state.data is still where the active run lives, but changing it is announced
// here rather than by the loader reaching into the DOM: map, panels, gages,
// time and the overview each subscribe and own their own reaction. Detail is
// { data, fitView }, with data === null when the run was cleared.
const activeListeners = new Set();

export function onActiveDatasetChange(fn) {
  activeListeners.add(fn);
}

export function emitActiveDatasetChange(detail) {
  for (const fn of activeListeners) fn(detail);
}

function freeSlot() {
  const used = new Set([...sources.values()].map((s) => s.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

function emit() {
  for (const fn of listeners) fn();
}
