# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-only map viewer for ngen-datastream t-route outputs. It browses the
CIROH community S3 buckets, loads a run's NetCDF/Parquet results client-side, and
paints per-reach flow/velocity/depth on the hydrofabric flowpaths over time. See
`README.md` for the feature list and the full module tree.

## Commands

There is **no build step, no package.json, no test suite, and no linter**.
Third-party libraries load from CDNs (MapLibre GL via a small module script in
`index.html` that sets the `maplibregl` global, since v6 is ESM-only; PMTiles via
`<script>`; jsfive, hyparquet, icechunk-js + zarrita via dynamic `import()` inside
the parse worker).

- **Run:** `bun serve.js` (or `PORT=3000 bun serve.js`). It must be served over
  HTTP — the ES modules and the module Web Worker will not load from `file://`.
  `python3 -m http.server 8000` also works. `serve.js` live-reloads open pages
  on any file change (CSS-only changes swap stylesheets in place); `RELOAD=0`
  turns that off.
- **Syntax-check a module** (no tooling, so this is the fastest sanity check):
  `node --check --input-type=module - < src/<file>.js`
- **Live-routing wasm** (only when touching `wasm/mc_route`):
  `cargo test --manifest-path wasm/mc_route/Cargo.toml` (includes a parity test
  against rs_route's kernel), then `./build-wasm.sh`. Its output in
  `src/vendor/mc_route/` is committed — never hand-edit it.
- **Deep link:** `?bucket=<name>&path=<prefix>` navigates the S3 browser on load.
- **Single-file build (optional):** `./build.sh` writes `dist/datastream_viewer.html`
  and its sidecar workers + wasm through a pinned `bunx bun@…`. A new
  `new Worker(new URL(...))` needs a line there, and a URL that is valid relative to
  the html file (`import.meta.url` is the page in that build).

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

A run may leave variables out (NWM output has no depth): its `matrices` then
lacks the key — parsers, merge and diff only build what's there — and anything
listing variables for a run goes through `hasVariable` / `datasetVariables`
(`data/access.js`). The variable picker disables the missing ones and switches
off a missing current variable before the run is painted.

Bounds, distribution samples, class breaks and per-timestep totals are derived
from these matrices and cached per (dataset, variable) through
**`derived(dataset, variable)`** in `data/access.js` — not bolted onto
`state.data` ad hoc. The `color/*` functions are pure and take
`(dataset, variable, scale, palette)` parameters, so they work for any loaded run.
Every colour map lives in `color/colormaps.js` (sequential, then diverging),
shared by runs, diffs and forcings; `ui/colormap.js` builds the pickers, which
list diverging maps first for a diff. A diff (`isDiff`, bounds symmetric about
zero) gets the **signed** form of every scale — the transform is applied to
|v| and the sign restored, and quantile / Jenks classify |v| and mirror the
breaks — so zero always sits on the palette's middle.

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

**Two reach networks.** `REACH_SETS` in `config.js` lists them: the
hydrofabric `flowpaths` (wb-N ids) and the NWM v3 `nwm-flowlines` (COMID ids,
RouteLink v3.1.6 attributes, **MLT** tiles: `encoding: "mlt"` on the source).
Each has a line layer, a fat invisible hover layer and an id label. A dataset
names its network in `reaches` (absent = hydrofabric) and `reachSetOf(data)`
resolves it; `map/paint.js` keeps one painter per network and only the active
run's has anything to paint, the sourcedata handler only feeds tiles of
`activeReachSource()`, and hover/click/`reachAt` follow the run's network.
`flowpathstyle.js` keeps paint per line layer (`setFlowpathPaint(prop, value,
layer)`). The live sim stays on the hydrofabric. NWM tile facts that matter:
z0–6 carry only id + `order` (attributes start at z7, so width expressions
`coalesce`), `lake`/`gages` are omitted when empty, z12 has extent 65,536,
reaches shorter than a tile unit are missing below z12, and the tiles'
`upstream_id`/`num_upstreams` are numbered over the NWM `to` tree, so they
can't be compared with the hydrofabric divides'. The map sets
`zoomLevelsToOverscale: undefined`: MapLibre 6's default clips tiles past a
source's maxzoom, and at z14 `querySourceFeatures` then returns ~10 flowpaths
rather than the tile's ~100, which would cut the sim's network and reach lengths,
the flood map's lines and "Load viewport" down to the view.

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

### URL and layer toggles (`ui/url.js`, `map/layerprefs.js`)

The query string carries the open panels, the S3 location, the camera
(`map=zoom/lat/lng[/bearing[/pitch]]`, written on `moveend`) and the layer
toggle buttons (`layers=` the keys that are on). A toggle's starting state is
the URL's `layers=`, else the last-used set in localStorage, else
`LAYER_DEFAULTS`. Every change goes to the URL through `noteLayer()`, but only
a button click calls `saveLayer()`, so opening a link doesn't overwrite
someone's saved settings. Code that toggles a layer itself (the context
menu's catchments, the flood panel's terrain) must not save.

### Panel settings (`ui/panelsettings.js`)

The sidebar header's menu shows/hides and reorders the panels, saved in the
`panelLayout` cookie (ids in order, hidden ones prefixed `-`). It moves the real
DOM nodes, so panels stay direct children of `.sidebar-content` and each needs an
`id` and a `.panel-title`. A new panel needs nothing else: one missing from the
cookie takes its `index.html` place. `.panel-hidden` only applies to a collapsed
panel, so code that opens a panel (`open=`, `showWindsAt`) still reveals it.

### Panel icons as layer switches (`ui/panellayers.js`)

A panel with something on the map calls `registerPanelLayer(panelId, { name,
isShowing, canToggle, toggle, stop })`. Its title icon then glows while the
layer shows, and a click toggles the layer without moving the panel; with
nothing to toggle the click falls through and opens the panel. Code that changes
a layer calls `syncPanelLayers()` (changes through `map/layerprefs.js` are
picked up). So flow particles, erosion and the flood map can now run with the
panel collapsed, though the title still starts and stops them. Forcings and rain
hide by **opacity**, not `visibility`: `FORCING_LAYER` must stay rendered for
catchment clicks and viewport queries. The live sim's icon only stops it, since
starting clears the loaded run.

`ui/overlaytooltip.js` is the forcing/rain/HUC hover tooltip, up while the panel is
open and its layer showing. The catchment outline is a line layer on `divides`
driven by feature-state, because a `setFilter` per hover would reload its tiles.

### Module dependency notes

Keep `state.js` / `config.js` as leaves to avoid cycles. `ui/dom.js` is also a
leaf (shared `labeledRow`/`iconButton`/`escapeHtml` builders) — build panel rows
through it rather than concatenating HTML, so escaping stays structural.

There are a few benign runtime cycles around `ui/time.js` (with
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
grows, so go through `liveViews()` rather than caching them. `sim/brush.js` and
`sim/rain.js` import `network.js`, never the reverse (they listen through
`onSimUpdate`). Rain mode loads forcings through the Forcings panel and sends
the worker a per-catchment (cat-N → wb-N) qlat table per forcing hour; the
worker floors each reach's qlat at that value before every 5-min step on its
own clock and loops the series when it runs out.

### qkrig (`data/workers/parsers/grid.js`, `map/grid.js`)

A qkrig day folder (`outputs/qkrig/qkrig.YYYYMMDD/`) has two loadable
products, and the S3 browser's file picker chooses between them
(`s3State.fileChoices`; the parquet is the default):

- `qkrig_output_YYYYMMDD.parquet`: the same long format as t-route parquet
  (`feature_id`, `time`, `type` = "cat", `qkrig_mm_hr`), ~830k catchments ×
  24 h ≈ 20M rows, brotli. `feature_id` is cat-N, whose number is its
  flowpath wb-N's, so it's an ordinary hydrofabric run.
  `PARQUET_COLUMN_ALIASES` (`config.js`) reads `qkrig_mm_hr` into the `flow`
  slot and relabels it (`variableInfo`). At that size the parquet parser
  reads one row group at a time, in two passes (ids/times, then values),
  with columns as typed arrays: no per-row `get()`, no `Number(bigint)`
  (64-bit ints are read as word pairs), and the time column's repeating
  cycle predicted rather than looked up per row. Don't regress those; a
  qkrig day parses in ~4 s.
- Hourly grids, below.

`outputs/qkrig/qkrig.YYYYMMDD/HH/interp_YYYY-MM-DD_HH.nc` is one hour of
USGS streamflow kriged onto a regular 200 × 200 lat/lon grid (`z_interp`,
mm/h, NaN outside the kriged area; no time variable — the hour is the
`date`/`hour` global attributes). `parseNetCDFBuffer` hands any file with
`z_interp` to the grid parser, which makes the cells the features (id =
latRow × nLon + lonCol + 1, only cells with a value) on the `grid` reach set
with `reaches: "grid"`, the centres in `data.grid`, and the value in the
`flow` slot relabelled through `data.variableInfo` — so read a variable's
label/units with `variableInfo()` (`data/access.js`), not `VARIABLES`
directly. `mergeDatasets` unions a day's hours as it does VPUs. `map/grid.js`
builds a GeoJSON square per cell when such a run becomes active (subscribed
before the paint), and the ordinary painter colours it (`fill: true` on the
set: `fill-color`, no width). Grid ids collide with wb-N/COMID numbers, so
anything matching ids across runs (gages, hydrograph series, diffs) checks
the network first.

### NWM forecasts (`data/nwm.js`, `data/workers/nwm.js`, `ui/nwmpanel.js`)

An NWM run is an ordinary dataset with `reaches: "nwm"` and no `depth`,
assembled on the main thread from one worker task per valid hour
(`nwmHour`). Every `channel_rt` file covers all 2,776,734 CONUS reaches,
each variable a 1-D int32 array (×0.01, fill −999900) in three
deflate + shuffle chunks; `hdf5layout.js` reads the chunked layout (layout
v3, v1 B-tree) and `decodeChunk()` undoes the filters. Variable attributes
are in dense storage the reader doesn't walk, so scale/fill are constants
in `config.js` (`NWM_SCALE`, `NWM_FILL`). `feature_id` is the same sorted
COMID list in every file: it's read once and cached in IndexedDB, and its
compressed size is a fingerprint each hour re-checks. The main thread maps
COMIDs to file rows and sends a sorted row list; the worker fetches only
the chunks those rows fall in. "Load viewport" takes the COMIDs in
the NWM flowline tiles loaded for the view (`querySourceFeatures`, turning
the layer on with `setNwmVisible`, which doesn't save), so below z12 short
reaches are left out, as the tiles leave them out. The panel has no
stride / window / order options: each configuration's `stride` and `hours`
in `NWM_CONFIGS` apply. File names are built
from `NWM_CONFIGS`, not listed; the newest cycle is found by HEADing each
candidate's last file.

### NWM retrospective (`data/retro.js`, `data/workers/retro.js`)

Single-reach series from the retrospective 3.0 `chrtout.zarr` for the
hydrograph (its "NWM retrospective" section shows for NWM reaches, which can
be clicked with no run loaded). The zarr's `feature_id` is the operational
COMID list in the same order, so a reach's column is its row in the cached
operational table (`nwmFeatureTable()`). A window costs one 672 h × 30,000
reach chunk per 28 days, 1–8 MB each, so the estimate HEADs every chunk
rather than guess. The worker decodes with zstddec (wasm, CDN, lazily
loaded in `parse.worker.js`), one 80 MB chunk at a time.

### Rainfall (`src/rain/`, `data/rain.js`, `data/workers/rain.js`, `ui/rainpanel.js`)

MRMS, IMERG Late and CHIRPS final from dynamical.org, listed in
`RAIN_PRODUCTS` (`config.js`): a mode of its own, in `rainState`, with its own
clock (`setRainTimeIndex()` is the only way to seek it; the timeline keeps it
with the other layers). Store URLs come from STAC, since their paths
carry a version. They're Icechunk, read by `icechunk-js` + `zarrita` (esm.sh,
lazily in `parse.worker.js`, passed to the pure reader); each worker opens its own
store.

- **Chunks are time-major**: one inner chunk holds a whole time block (MRMS 27
  days × 1° × 1°; IMERG 30 days × 10°; CHIRPS 1 year × 3°). So one map frame costs
  the same as the block, and one cell costs a chunk per block. Whole-CONUS MRMS is
  ~490 MB; `planRainLoad` measures any load from the shard indexes (a few kB each)
  first, and the panel confirms above `RAIN_CONFIRM_BYTES`. Nothing touches the
  network until a Load button: opening a reach stays free.
- A load is sampled (every Nth cell, not averaged) to fit `RAIN_MAX_CELLS` and
  `RAIN_MAX_MEMORY_BYTES`, and held as `frames[t][row][col]`, float, in the
  variable's display units. A chunk is one `rainTile` task on the pool.
- **Cells** draw on a canvas source. Its corners are interpolated in Mercator and the
  grid is regular in latitude, so canvas rows look up the grid row at their own
  latitude (`rowLut`). **Catchment means** go through a second state painter on the
  `divides` source, with the feature-state key `rain` so forcings can be painted on
  the same features. A divide comes in one piece per tile, so its cell list is
  gathered across pieces, and the table is rebuilt as divide tiles land.
- The **hydrograph** shows one cell's series (the middle of the reach's geometry in the
  loaded tiles, else its gage) as a strip above the plot. It's kept out of
  `view.series`: other units, no place in the skill scores.
- **Credits:** `credit.long` is shown in the panel and hydrograph section
  (`rain/credit.js`), `credit.short` on the map while the layer is on.
  `map/credits.js`'s `setMapCredit(owner, credit)` swaps MapLibre's
  `AttributionControl`, which has no API to change its text. So the map is
  created with `attributionControl: false`.

HRRR and URMA are next: see `todo.md`. They need the virtual stores (GRIB byte
ranges, one whole-domain chunk per step), so most of the above assumptions don't
carry over.

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
  forcing clock, which is separate from `setTimeIndex()`'s (the timeline keeps
  them together). Changes are
  announced through `onForcingChange` (`forcing/store.js`) — panel, plot and
  paint subscribe; the loader doesn't drive the DOM.

**Clicks:** left-click on a catchment opens the forcing plot
(`ui/forcingplot.js`) unless a reach (with a run loaded) or a gage is under the
cursor. The right-click menu (`ui/contextmenu.js`) offers forcings, the
hydrograph, the upstream highlight and winds aloft; it only opens for a right click that
didn't drag, since right-drag rotates the map. The forcing plot and the
hydrograph share the dock's spot and close each other via a `dockopen`
document event.

### USGS site catalog (`data/usgscatalog.js`, `map/usgssites.js`)

Every USGS site with a continuous time series (~27k sites, ~70k series) is
on the map regardless of any run. It comes from the Water Data API's
`combined-metadata` collection — the only one that joins series (parameter,
begin/end) to location (name, point, site type) — filtered to
`data_type = 'Continuous values'`. Its pages are cursor-chained, so
`data/workers/usgscatalog.js` splits it into six `monitoring_location_id`
ranges fetched in parallel (~6 MB gzipped, ~5 s; one chain is ~12 s). Only GET
with `filter-lang=cql-text` works; POST/CQL-JSON is blocked. The worker
merges series per (site, parameter) and assigns each parameter an
observation type by name (`USGS_OBS_TYPES` in `config.js`: ordered regexes,
also the colour priority).

The main thread caches the worker's output in IndexedDB (its own DB, not
the forcing-layout one) and serves it from there, refreshing in the
background after `USGS_CATALOG_TTL_MS`. `install()` derives per-site type
bitmasks (all-time and active within `USGS_ACTIVE_WINDOW_MS`), normalized
names, and **river groups**: sites whose name before the first locator word
("AT", "NR", "BLW", …) names the same waterbody, split by single-linkage
distance that grows with drainage area (so the lower Mississippi stays one
group and the many "Mill Creek"s don't merge). The GeoJSON layer carries only
`{ id, no, f }`, where `f` is the type bitmask of the site's series that pass
the panel's period (recent / any / date range) and min-record-length settings,
zeroed for sites outside its drainage-area range or failing its dams setting (`filteredMasks()` in
`map/usgssites.js`, cached per catalog + settings; the panel's counts and its
copy/save-as-CSV list, via `shownSites()`, read it too).

The dams setting ("just below a dam" within N mi / not / "no dams upstream")
is the one catalog fact not fetched in the browser: `data/usgsdams.json` is
built offline by `scripts/usgs-dams.js`. "Below a dam" is regex-scanned from
each site's station description (`waterdata.usgs.gov/manuscripts/<id>`, the
LOCATION / REMARKS text): one request per site and no CORS header, so the
browser can't. "No dams upstream" is GAGES-II `NDAMS_2009 = 0` (NID dams in
the watershed), else the description saying "no regulation". Retune the
regexes against a `--cache` dir rather than refetching. The network setting
(on a NextGen flowpath / NWM reach) is built offline too, by
`scripts/network-gages.js` into `data/networkgages.json`: the browser only sees
network gages tile by tile, and a CONUS density needs them all. A site on a
network but with no continuous record isn't in the catalog, so it can't show.
Changing those resets the source data; type
toggles rebuild just the filter and colour expressions (bit tests via
`%`/`floor`, since expressions have no bitwise ops). Both persist in
localStorage. The run's own gages
(`map/gages.js`, hydrofabric tiles) stay a separate layer drawn on top and
own the hover/click where they overlap, since only they know the reach for
the hydrograph. Gage tooltips use `catalogMeta()` when the site is in the
catalog and fall back to `fetchGageMeta()`.

The density heatmap (`map/usgsdensity.js`, `layers=density`) draws the same
filtered sites as a MapLibre heatmap in real units: `heatmap-density` 1 means
the panel's full scale in sites per 1000 km². The kernel's radius is fixed on
the ground, the intensity follows from MapLibre's shader (peak =
weight × intensity × 0.3989, so the integral is known), and each point's weight
undoes Mercator's area stretch. It has its own source with `maxzoom: 3`, since
a heatmap only draws the points of tiles in view and a kernel can be wider than
a tile. Below the zoom where the radius would be under 16 px it stays 16 px
(the kernels are drawn at ¼ resolution and alias) and the intensity drops to
match, so a colour keeps its meaning. With terrain on MapLibre draws each tile
separately, so kernels clip at the z3 tile edges (seams at 90°W and 41°N).

Gage observations for the hydrograph (`fetchGageFlow` in `data/usgs.js`)
come from the `continuous` collection, which rejects a time envelope over
1100 days. The range is split into UTC calendar-year windows (one ~1 MB page
of 15-min data each), fetched three at a time with a timeout and retries for
timeouts / 429 / 5xx, each memoised and Cache-API cached on its own; a window
that still fails is counted in `failed` instead of sinking the rest.

### HUC boundaries (`map/huc.js`, `ui/hucpanel.js`)

`huc.pmtiles` has one source-layer per level, each with `huc` (string, keeps
leading zeros) and `name`. A level starts at its own zoom (`HUC_LEVELS` in
`config.js`) and runs to the tiles' z12. Each level is a line layer plus an
invisible fill, the fill being what the tooltip queries, and is its own key in
`layers=`. The source fetches no tiles while every level is off. The title icon
hides all levels and restores the same set.

Search (`data/hucindex.js`, `data/workers/hucindex.js`) can't use the tiles,
which can only be read by place, and USGS's WBD service is too unreliable to
query live. So `scripts/huc-index.js` builds `hucindex.parquet` offline from the
z8 tiles (~56 MB of range reads; z8 is the first zoom holding every level), to be
uploaded by hand to `map/index/hucindex.parquet`. Rebuild it if `huc.pmtiles`
changes. Name search needs every name in the browser, so opening search reads the
`huc` and `name` columns (~1 MB) through the parse pool; a unit's bounds are one row
group (~50 kB), read when it's picked. A found unit is outlined by its level's
`hucSearchLayer`, kept separate from the toggles.

### Search (`map/search.js`)

The magnifier button at the top right pops out a box with a suggestion
dropdown: the best-matching river group with its gages listed under it,
hydrologic units, other groups, then sites (fuzzy on normalized names —
abbreviations expanded, spaces ignored, trigram fallback for typos — or by
site-number prefix), and the catchment for `cat-N` / `wb-N` / a short bare number.
`huc 1027` / `huc8 kansas` lists only hydrologic units. Enter takes the
highlighted row, else the first; a group frames and rings all its gages.
A gage is placed from the catalog, else loaded gage tiles, else the USGS
station metadata (`fetchGageMeta(site).lonLat`), and ringed by
`SEARCH_POINT_LAYER` (a GeoJSON source of any number of points). Catalog
coordinates win over the hydrofabric's gage point, which can sit ~1 km off.

A catchment already in loaded divides tiles is framed from its geometry.
Anything else is looked up in `hydrofabric_index.parquet` on the hydrofabric
bucket through hyparquet (CDN, lazy in the parse worker; parquet-wasm can't do
Range reads). That file isn't sorted by id, so the first search scans its
whole `id` column (~10 MB) into a sorted `cat-N → row` table cached in
`search.js` for the session; each search then reads one row's lon/lat (~2 MB,
one row group). Found catchments are outlined by `SEARCH_LAYER`, and their
forcing plot opens if a forcing source is set.

### NEXRAD radar (`src/nexrad/`)

A third independent mode: Level II volume scans from the public
`unidata-nexrad-level2` bucket, one per chosen station (`nexradState.radars`),
each drawn as a deck.gl `PointCloudLayer` in NEXRAD's
`MapboxOverlay` from `map/deck.js` (deck.gl is imported as ES modules from esm.sh on first use —
it's not in `index.html` — and runs on WebGPU when `requestAdapter()` succeeds,
WebGL2 otherwise; the UMD bundle can't be used because its `window.luma` lacks
the classes `@luma.gl/webgpu` extends). `source.js` downloads the file and splits it into LDM records
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

Bird mode (`BIRD`, a pseudo-moment) decodes REF gated by RHO in the worker,
plus additive per-height sums (`PF` in `data/workers/nexrad.js`) that
`nexrad/birds.js` solves into a density + VAD profile. Points decode to 150 km
and `buildPoints` trims them by `nexradState.birdRange` (so the slider never
re-decodes); the profile only uses 5–40 km.

### Flow particles (`src/flow/`, `ui/flowpanel.js`)

A fourth independent mode: wind-map-style particles running down the DEM.
Opening the panel starts it, collapsing stops it, its icon does either without
moving the panel; settings are `flowState`
(`state.js`). Three layers:

- **`flow/field.js`** decides what to route: one mosaic over the view plus a
  margin, in global pixels of the DEM source's tiles at a zoom tied to the
  map's (`flowState.detail` below it), stepped down until it fits
  `FLOW_MAX_CELLS`. Pitched far ground is clipped a few screen-widths out. A
  view the current field doesn't mostly cover gets a coarse field (two zooms
  down) first, then the fine one. Requests carry an epoch, and the higher id wins.
- **`flow/flow.worker.js`** fetches the same tile URLs as `FLOW_DEM_SOURCE`
  (the hillshade's raster-dem source: its `tiles`/`encoding`/`tileSize` are
  read off `map.getSource()`), so they're HTTP-cache hits. It does **not**
  read MapLibre's own loaded tiles: those are private, live in MapLibre's
  workers, and come at whatever mixed zooms the terrain/hillshade picked.
  It decodes them via `createImageBitmap` with no colour conversion or
  premultiplication, and keeps an LRU. Browsers with fingerprinting
  protection perturb canvas readback (a flipped red byte is a 256 m spike),
  so when a probe detects that, pixels are read through `VideoFrame`
  instead, as MapLibre does. Tiles that 404 (past the data's
  zoom) are filled from their nearest ancestor, upsampled in that zoom's
  global pixels (reading neighbouring ancestors across their seams), so mixed
  DEM resolution is seamless. Fetch failures are counted separately so the
  field gets retried.
  It's its own worker, not the parse pool, because the tile cache lives there.
- **`data/workers/flowroute.js`** (pure) routes the mosaic. It runs
  Priority-Flood + ε from the edges and the cells at or below 0 m / no data,
  which are outlets, so closed basins below sea level end there. Receivers
  are then re-picked as steepest descent on the filled surface; the flood's
  own receiver is the *lowest* neighbour, which biases flow about 40° toward
  the diagonals. Accumulation is a Kahn pass. Direction is the filled-surface
  Horn gradient on hillslopes, blended as accumulation grows into the
  direction toward the cell `LOOKAHEAD` steps down the receiver chain. Aiming
  at the next cell instead makes the bilinearly sampled field stall where D8
  receivers converge, so keep the look-ahead.

`flow/particles.js` simulates on the CPU (positions in Mercator [0, 1], so
they survive a field swap). Its `step()` is the hot loop, with sampling
inlined over one interleaved `[dirX, dirY, ±speed, elev]` record per cell
(`data/workers/flowcells.js`, packed in the flow worker for the settings
the field was requested with; outlets carry negated speed). Keep it free of
per-sample property lookups and module-global writes: those, not memory
traffic, were most of its cost. Trails are a **ring of `LineLayer`s**, one per
frame of trail, each holding that frame's one segment per particle and
fading by its layer `opacity` as it ages. A frame therefore writes and
uploads only the newest layer, not every trail. The newest layer always takes
the spare buffer set, because deck only re-uploads an attribute whose typed
array changed identity. Speed is
per-field normalised (90th percentile = 1) and converted with css px per
field cell, so on-screen speed doesn't depend on zoom. Positions switch to
`LNGLAT_OFFSETS` around the field centre when it's small, for float32
precision. z is the DEM × the terrain exaggeration (0 with terrain off).

When the flow overlay's device is WebGPU, **`flow/gpusim.js`** runs the
same step as a compute shader on deck's own device (`deckDevice()`), and
particles.js keeps the CPU step as the fallback (WebGL2, or a pipeline that
fails to build). Keep the two steps in sync. On the GPU:
- particle positions are f32 field cells, remapped (x·k + c, c in f64)
  when a field lands;
- the ring is per-frame **positions** (slot i's layer draws slot i−1 → i),
  so a frame whose origin changed draws no segment;
- deck applies a new layer list only in its own rAF callback, which runs
  before ours, but a camera move makes MapLibre's `render` redraw deck
  afterwards with the list from the tick before. So the ring keeps two
  undrawn spare slots (no list deck may still draw reads the slot a step
  writes), every slot is emitted each frame with a stable id (`visible:
  false` for the spares), and dropped ring buffers are destroyed a few
  frames late;
- each slot is its own `VERTEX | STORAGE` buffer laid out `[x, y, z, 0, 0, 0]`
  (deck's line positions are float64, and WebGPU needs every attribute to
  start within its stride). They're handed to deck with a placeholder
  Float32Array `value` next to the buffer: without one, deck binds the low
  half as a constant attribute, which WebGPU can't do.

**`map/deck.js`** owns deck.gl's loading and one `MapboxOverlay` per mode
(`setDeckLayers(owner, layers, props)`, or `deckDevice(owner)` for a mode that writes its own GPU buffers). They're kept separate on purpose: an overlay
redraws all of its layers when any one changes, and the particles change
every frame. Its esm.sh imports pin `@deck.gl/core` through
`?deps=`, because otherwise a new core patch release gets loaded next to the
pinned one and deck refuses to run.
It also gives the map a small `map.transform` with just `elevation`, which
`@deck.gl/mapbox` reads while terrain is on and MapLibre 6 removed.

### Particle erosion and terrain edits (`flow/terrain.js`, `flow/brush.js`, `ui/erosionpanel.js`)

Settings are `erosionState` (`state.js`) and apply only while the erosion
panel is open (opening it opens the flow panel). Both particle steps carry a
per-particle speed and sediment (the GPU's in a `motion` vec4) as well as
the heading:
- **Interaction**: the field is binned ~`range` css px; each particle's
  speed is pulled toward *last* frame's bin mean (two halves of bins,
  swapped per frame, so no frame reads what it's writing).
- **Erosion**: impact = speed lost along the previous heading
  (`|v₀| − v₁·v̂₀`), eroding the cell one ahead, scaled by
  `1 / (1 + hardness·S / 5%)`. Deposits go where the particle is; all of it
  on ageing out or at an outlet; off the field it's lost.
- The erosion sums into a field-sized grid (CPU `Float32Array`; GPU fixed
  point via `atomicAdd`, read back by `takeErosion()`) that is committed every
  `interval` s and whenever the field moves: `addTerrainDelta()` then
  `rebuildFlowField()`.

The WGSL is at WebGPU's default **8 storage buffers per stage**: read-only
per-cell data shares one `aux` buffer and the bins + erosion grid share one
atomic `acc` buffer. Don't add a binding; pack into those.

`flow/terrain.js` keeps edits as per-DEM-tile metre deltas at the zoom they
were made at (`data/workers/flowterrain.js` resamples and sums across zooms).
At the first edit it **switches `FLOW_EDIT_SOURCES` to the `flowdem://`
protocol** via `setTiles`; untouched tiles are the original bytes, edited ones
come from `terrain.worker.js` (decode, add, re-encode as a hand-written PNG,
since canvas exports are perturbed by fingerprinting protection). So
`map.getSource(...).tiles` is no longer the real URL: go through
`demSource()` / `demTemplate()`. `map.refreshTiles` only reloads tiles in
view, so served tiles are versioned and stale ones are refreshed on
`moveend`. Field builds carry `deltasFor()` their box.

### Flood mapping from a run (`src/fim/`, `ui/floodpanel.js`)

The flood panel's "the loaded run" mode (its other mode is the flat
`FLOOD_LAYER` level). `fim/fim.js` plans a box over the view at a DEM zoom
tied to the map's (`FIM_MIN_ZOOM`..`FIM_MAX_ZOOM`, stepped down to
`FIM_MAX_CELLS` and `FIM_MAX_SIDE`), collects every NWM flowline in the loaded
tiles (`querySourceFeatures`; an invisible `FIM_NWM_LOADER` layer keeps them
loading whatever the NWM toggle says) and sends a `hand` request to **its own
instance of `flow/flow.worker.js`** — not the particle field's, which lives
and dies with the flow panel — sharing the mosaic code (`buildMosaic`), the
ancestor fallback and the terrain deltas. Above `HAND_PREVIEW_CELLS` the
worker first replies with a half-resolution field (`preview: true`, z − 1,
from the same mosaic, so no extra tiles); the request stays pending for the
full one. `data/workers/hand.js` burns the lines in (lowered `BURN_M`; higher
order wins a shared cell), routes with `drainageTree()` from `flowroute.js`
and walks its topological `order` backwards: a burned cell is its own
drainage, others copy their receiver's. It returns HAND + a per-cell reach
number, once per view. `drainageTree`'s flood uses an inlined bucket queue
(1/256 m bins) instead of a heap; it's memory-bound from there (cells are
visited in elevation order, all over the grid), so the GPU wouldn't help it.

Per timestep (`onTimeChange` in `ui/time.js`, the subscription
`setTimeIndex` fires) each reach gets a stage (`fim/stage.js`) against its
RouteLink compound channel (z = 1 / `ChSlp`), less the bankfull depth by
default: an NWM run's from flow ÷ velocity; an **ngen run's** from t-route's
`depth` (else flow ÷ velocity) on the reach's **outlet wb-N**, looked up in the
NextGen ↔ NWM crosswalk (`ngenCrosswalk()` in `data/nwm.js`, parse-worker
task `crosswalk`, one 2.4 MB GET then IndexedDB; exactly one flowpath per
COMID is its outlet). The image is drawn by `fim/gpupaint.js` (WebGL2: HAND
and reach numbers uploaded as textures once per field, the stages as a small
texture per step, depth + colour in a fragment shader) or, without WebGL2,
one CPU pass into a 2D canvas. Either canvas backs a runtime canvas source
(`FIM_SOURCE`, re-added after a style switch; a non-animated canvas uploads
via `play(); pause()`). The flooded-area readout is counted on the CPU only
once the clock stops (`AREA_DELAY_MS`). The HAND field doesn't depend on the
run.

### Winds aloft (`src/winds/`, `ui/windspanel.js`)

Open-Meteo hourly pressure-level winds for one point, fetched straight from
the browser (forecast API for recent days, historical-forecast API back to
2021) and cached per point and days. `windAt()` interpolates in time and
height; bird mode subtracts it from the VAD for airspeed. The panel is opened
at a point by `showWindsAt()` (right-click menu, bird profiles).

### The timeline (`ui/timeline.js`, `ui/timelinedock.js`, `ui/playback.js`)

The one transport, docked along the map's bottom and hidden until a layer with a
clock is loaded. No panel has its own playback. A mode registers a function
returning its tracks (`registerTimelineTracks`, like `registerPanelLayer`; the
descriptor is documented at the top of `ui/timeline.js`), calls `syncTimeline()`
when they change, and `trackMoved(key, i)` when its own clock moves, so a seek
from the hydrograph or forcing plot brings the rest along. A new mode with a
clock needs nothing else.

- **One playhead, epoch ms; each layer keeps its own clock.** A following track
  (`seek`) goes to its step nearest the playhead. `timeline.js` imports nothing,
  so modules that own a clock can import it freely.
- **Play and step go by steps, not time**: to the next step of *any* following
  layer. So the finest layer sets the pace, a gap between layers takes no time,
  and `state.playSpeed` is steps per second.
- **A layer the playhead has left holds its nearest step**, its row marked
  "held". It isn't hidden, so its eye / panel icon has one meaning.
- **Loading a layer outside the playhead pulls the playhead to its start.**
- **NEXRAD doesn't follow** (`pick` instead of `seek`): each scan is a download.
  Its row shows ticks for the listed scans; a click loads one.
- A run with no reference time (`relative`) starts where the dated layers do, or
  the axis reads T+ hours if there are none.
- The dock's height is `--tl-h` on the root, and everything anchored to the map's
  bottom (hydrograph and forcing docks, info card, sim buttons, MapLibre's corner
  controls) stands on it. The run's clip draws its basin total per timestep.

The live sim isn't on it: its clock has no dates. It does move the forcing clock
in rain mode, and the playhead follows that.

### Changing the timestep, and the active dataset

Two rules that keep the wiring from sprawling:

- **`setTimeIndex(i)` in `ui/time.js` is the only way to seek a run.** It owns
  the repaint and tells the timeline. Don't re-inline that sequence.
  `updateFeatureStates()` already ends in `refreshTooltip()`, so callers must
  not call it again.
- **`data/loader.js` announces the active run; it doesn't drive the DOM.**
  `promote()` sets `state.data` and calls `emitActiveDatasetChange({ data, fitView })`
  (`data/sources.js`); `map/init.js` subscribes panels, paint, gages and the
  timeline. To react to a run loading or clearing, add a subscriber in the module
  that owns that DOM — don't add a line to `promote()`. Dataset-level rules (e.g.
  a diff using signed scales and its own colour-map choice) live as properties
  on the dataset and are read by the module that owns the control.
