# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-only map viewer for ngen-datastream t-route outputs. It browses the
CIROH community S3 buckets, loads a run's NetCDF/Parquet results client-side, and
paints per-reach flow/velocity/depth on the hydrofabric flowpaths over time. See
`README.md` for the feature list and the full module tree.

## Commands

There is **no build step, no package.json, no test suite, and no linter**.
Third-party libraries load from CDNs (MapLibre GL + PMTiles via `<script>` in
`index.html`; jsfive + hyparquet via dynamic `import()` inside the parse worker).

- **Run:** `bun serve.js` (or `PORT=3000 bun serve.js`). It must be served over
  HTTP — the ES modules and the module Web Worker will not load from `file://`.
  `python3 -m http.server 8000` also works.
- **Syntax-check a module** (no tooling, so this is the fastest sanity check):
  `node --check --input-type=module - < src/<file>.js`
- **Live-routing wasm** (only when touching `wasm/mc_route`):
  `cargo test --manifest-path wasm/mc_route/Cargo.toml` (includes a parity test
  against rs_route's kernel), then `./build-wasm.sh`. Its output in
  `src/vendor/mc_route/` is committed — never hand-edit it.
- **Deep link:** `?bucket=<name>&path=<prefix>` navigates the S3 browser on load.

## Architecture

`src/main.js` is a thin entry; `map/init.js` creates the map and wires all event
listeners. `state.js` and `config.js` are dependency leaves (import nothing) — the
shared mutable singletons live in `state.js`, including the map instance, which is
a **live binding** set once via `setMap()` so every module sees it after init.

Three cross-cutting design decisions explain most of the code and are not obvious
from any single file:

### 1. The in-memory data model

A loaded run lives in `state.data` as **feature-major `Float32Array` matrices**,
indexed `matrix[featureRow * nTimes + timeIndex]`. `state.data.index` maps a
feature id → row. `-9999` (`FILL_VALUE` in `config.js`) is the missing-data
sentinel; test it with **`isValid(v)`** from `config.js` (and `RESULT_IS_FILL`
for MapLibre expressions) rather than writing the `-9998` threshold by hand.

Read a cell with `valueAt(variable, row, timeIndex, data = state.data)` and a
whole reach with `seriesAt(dataset, reachId, variable)`, both in `data/access.js`.
Every accessor there takes the dataset it works on and only *defaults* to the
active run, because the hydrograph and the diff pickers routinely need a run
that isn't the one on the map.

`time` is **always absolute epoch milliseconds** when `data.timeAbsolute` is
true — the parsers normalize it (NetCDF converts its seconds-since-`refTime`
where `refTime` is in hand). Nothing downstream branches on file format to
decide the clock's units. A run whose reference time was unparseable keeps raw
seconds and sets `timeAbsolute: false`.

Bounds, distribution samples, class breaks and per-timestep totals are derived
from these matrices and cached per (dataset, variable) through
**`derived(dataset, variable)`** in `data/access.js` — not bolted onto
`state.data` ad hoc. The `color/*` functions are pure and take
`(dataset, variable, scale)` parameters, so they work for any loaded run.

### 2. Painting via MapLibre feature-state (not repainting)

The flowpaths line paint expression is set **once per (variable, scale)** in
`map/paint.js` using expressions from `color/expressions.js`; those expressions
read `["feature-state", "value"]` (see `RESULT_VALUE` in `config.js`). Changing
the timestep therefore does **not** touch paint — it only writes new feature-state
values. The on-screen bookkeeping lives in **`map/statepainter.js`**
(`createStatePainter`), which sets state for **only the features currently on
screen** (`queryRenderedFeatures`), tracks what it has already painted for the
current `variable:timeIndex` key, and reruns incrementally as tiles stream in
or the viewport moves (wired in `map/init.js` via `movestart` / `idle` /
`sourcedata`, rAF-coalesced). `map/paint.js` owns the flowpaths painter
(`updateFeatureStates` / `scheduleFeatureStateUpdate` are its methods) and
`forcing/paint.js` owns a second one for the catchments; each painter has its
own view-dirty flag, so there's no global one in `state.js`. When touching
color scales or painting, preserve this: expression = per-variable,
feature-state = per-timestep.

The painter tracks a `paintedAll` flag plus a small delta set rather than a
per-id `Set`: on a bare timestep change every on-screen feature must be
repainted anyway, so a full-size Set whose every lookup misses was pure
overhead. It also reuses one feature descriptor object across the loop.

### 3. The parse/merge worker boundary

Heavy, one-shot work — NetCDF/Parquet decoding, CONUS merge, bounds — runs in a
module worker (`data/workers/parse.worker.js`), which imports jsfive/hyparquet
lazily. Parsers return `{ time, timeAbsolute, nTimes, featureIds, matrices, refTime }`
where `matrices` is keyed by `VARIABLE_KEYS` (from `config.js`) — never a
hardcoded flow/velocity/depth triple, so adding a routed variable is a
`config.js` edit. Parsed matrices are **transferred** (not copied) back to the main thread,
which owns them from then on; that is deliberate, because feature-state painting
reads them synchronously every frame during playback, so a per-frame worker
round-trip would add latency. `data/loader.js` runs a bounded worker pool: a
single file is one `parse` task; a CONUS load fans every VPU file across the pool
then sends the results back in for a `merge` task. Every reply carries its
payload as `result` (the protocol is listed at the top of `parse.worker.js`);
the forcing loader shares the same pool through the exported `runTask`.

**Worker-side modules** (`data/workers/**`) must stay pure — no DOM, no map, no
`state.js`. They may import only `config.js`. Parsers receive their CDN library as
a parameter so the "which import form works" question is isolated to the worker
(jsfive's `+esm` build exports `File` as a named export with no default, hence the
`mod.default ?? mod` fallback).

### Module dependency notes

Keep `state.js` / `config.js` as leaves to avoid cycles. `ui/dom.js` is also a
leaf (shared `labeledRow`/`iconButton`/`escapeHtml` builders) — build panel rows
through it rather than concatenating HTML, so escaping stays structural.

There are a few benign runtime cycles around `ui/time.js` (with `ui/overview.js`,
`ui/hydrograph.js`, and `map/paint.js` ↔ `map/interactions.js`). Every one of
them only calls across the cycle **inside functions**, never at module-eval time
— safe, but don't add eval-time uses of those imports.

### The live routing sim (`src/sim/`)

A separate mode, not a dataset: `sim/network.js` collects reaches from
`querySourceFeatures` over the flowpath tiles and ships their columns to
`sim/sim.worker.js`, which owns the wasm `Network`. Each animation frame posts
one step batch (never more than one in flight); the reply carries only the
reaches the wasm side reports dirty, as wb-id / q arrays, and the main thread
writes their feature-state. Deposits and the hovered-reach readout go through
messages too — `reachState()` returns `undefined` while a probe is out and
fires `onSimUpdate` when it lands. Every message carries an `epoch`, bumped on
start/stop, so late replies from a stopped sim are dropped. While
`state.simActive` it owns the flowpaths paint and feature-state; starting it
calls `clearData()`, and it subscribes to the active-dataset event (registered
*before* `syncPaintToDataset`) to stop when a run loads. It rebuilds on
`moveend`/`sourcedata`, never `idle` — a running sim keeps the map from idling.
In the worker, the typed-array views onto wasm memory detach whenever memory
grows, so go through `liveViews()` rather than caching them. `sim/brush.js` imports
`network.js`, never the reverse (it listens through `onSimUpdate`).

### Forcings (`src/forcing/`)

Another mode independent of `state.data`: ngen forcing files painted on the
catchments (the `forcing-divides` fill on the `divides` source), with state in
`forcingState` (`state.js`). A t-route run and forcings can be on screen at
once — their feature-state lives on different sources.

- **Nothing is downloaded whole.** Each forcing variable is a contiguous
  (catchment × time) float64 matrix, so rows are fetched with HTTP Range
  requests. `data/workers/hdf5layout.js` is a small async HDF5 reader (only the
  subset these files use; anything else throws "unsupported") that finds each
  variable's byte offset and the ordered `cat-N` ids in ~10 requests;
  `forcing/layout.js` caches that per file URL in IndexedDB. Offsets differ
  per file, even between cycles, so the URL is the only safe key.
- **Row order is not spatial**, so a viewport's rows are scattered through the
  file. `planRuns()` in `data/workers/forcing.js` picks the merge gap per
  request by a cost model (requests × `FORCING_REQUEST_COST_BYTES` + bytes);
  the main thread runs the same function to estimate a load before it starts,
  and the panel confirms big ones. Don't swap in a fixed gap.
- **The store is sparse** (`forcing/store.js`): catchments get a slot as they
  load and the matrices grow by doubling, with the same
  `matrix[slot * nTimes + t]` shape as a t-route dataset, so `valueAt`,
  `seriesAt`, `derived()` and `color/*` work on it unchanged. `index` is keyed
  by the numeric catchment id (the divides tiles' feature id). Bounds and the
  derived cache are recomputed after each load batch.
- **Sources** are `{ url }` (Range fetch; anything but 206 is an error) or
  `{ file }` (a dropped File, read with `Blob.slice`), so local files go
  through exactly the same path.
- `setForcingTimeIndex()` (`forcing/paint.js`) is the only way to seek the
  forcing clock, which is separate from `setTimeIndex()`'s. Changes are
  announced through `onForcingChange` (`forcing/store.js`) — panel, plot and
  paint subscribe; the loader doesn't drive the DOM.

**Clicks:** left-click on a catchment opens the forcing plot
(`ui/forcingplot.js`) unless a reach (with a run loaded) or a gage is under the
cursor. The right-click menu (`ui/contextmenu.js`) offers forcings, the
hydrograph and the upstream highlight; it only opens for a right click that
didn't drag, since right-drag rotates the map. The forcing plot and the
hydrograph share the dock's spot and close each other via a `dockopen`
document event.

### NEXRAD radar (`src/nexrad/`)

A third independent mode: Level II volume scans from the public
`unidata-nexrad-level2` bucket, one per chosen station (`nexradState.radars`),
each drawn as a deck.gl `PointCloudLayer` in one
`MapboxOverlay` (deck.gl is injected from unpkg on first use — it's not in
`index.html`). `source.js` downloads the file and splits it into LDM records
on the main thread (`splitRecords`), then fans byte-balanced batches across the
shared parse pool (`runTask({ type: "nexrad" })`); `data/workers/nexrad.js` +
`bzip2.js` decode them into per-cut x/y (metres from the radar) / z (metres
MSL) / value columns, and `mergeCuts` joins cuts split across batches and drops
repeated tilts (split cuts, SAILS). The display arrays are rebuilt only for
product/threshold/tilt changes; vertical exaggeration is a model-matrix scale,
so it only re-renders. State is `nexradState` (`state.js`).
`stations.json` is a static GeoJSON of the sites, imported with
`with { type: "json" }` so the single-file build inlines it. Its coordinates
come from each radar's own Level II header rather than HOMR, because the point
cloud is placed by that header and HOMR is kilometres off for most TDWRs.

### Changing the timestep, and the active dataset

Two rules that keep the wiring from sprawling:

- **`setTimeIndex(i)` / `stepTime(delta)` in `ui/time.js` is the only way to
  seek.** It owns the slider sync, the repaint and the readout. Don't re-inline
  that sequence, and never drive it by dispatching an `input` event at the
  slider. `updateFeatureStates()` already ends in `refreshTooltip()`, so callers
  must not call it again.
- **`data/loader.js` announces the active run; it doesn't drive the DOM.**
  `promote()` sets `state.data` and calls `emitActiveDatasetChange({ data, fitView })`
  (`data/sources.js`); `map/init.js` subscribes panels, time, paint, gages and the
  overview. To react to a run loading or clearing, add a subscriber in the module
  that owns that DOM — don't add a line to `promote()`. Dataset-level rules (e.g.
  a diff only allowing the linear scale) live as properties on the dataset and
  are read by the module that owns the control.
