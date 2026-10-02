# datastream_viewer

live demo [here](https://joshcu.github.io/datastream_viewer/)

A browser-based map viewer for [ngen-datastream](https://github.com/CIROH-UA/ngen-datastream)
t-route outputs. It browses the CIROH community S3 buckets, loads a run's
NetCDF or Parquet results directly in the browser, and paints per-reach flow /
velocity / depth on the hydrofabric flowpaths over time.

## Features

- **S3 browser** — navigate bucket → cycle → VPU folders and pick a t-route
  output file, or load an entire CONUS cycle at once.
- **Results playback** — scrub or auto-play through timesteps; the flowpaths
  recolor via MapLibre feature-state as reaches stream into view.
- **Color scales** — linear, log, sqrt, cbrt, symlog, plus quantile / quantile-class
  / Jenks natural-breaks classifications.
- **Inspection** — hover tooltip, per-reach click panel, a basin-total
  sparkline, and a right-click menu (forcings, hydrograph, highlight upstream
  catchments).
- **Forcings** — pick an ngen forcing cycle from S3 (or drop forcing `.nc`
  files) and paint any forcing variable on the catchments over time. Nothing is
  downloaded whole: the file layout is read in-browser and only the rows for
  the catchments in view ("Load viewport"), a whole VPU ("Load VPU") or a
  clicked catchment are fetched with HTTP range requests, then cached. Clicking
  a catchment plots all its forcing variables.
- **NEXRAD radar (3D)** — pick a date, then one or more stations and a scan
  time for each from the public NOAA NEXRAD Level II archive
  (`unidata-nexrad-level2`), and see each whole volume scan as a deck.gl point
  cloud, each gate at its beam height. With the lock on, stepping one station
  moves the others to their scan nearest its time. Choose reflectivity /
  velocity / ZDR / CC, one tilt or all, a minimum value, and the vertical
  exaggeration, point size and opacity. Station dots (WSR-88D and TDWR) show on
  the map while the panel is open; click one to add it. The files are
  bzip2-decoded in the worker pool. **Birds** mode keeps reflectivity gates
  5–40 km out whose ρHV < 0.95 (not rain), converts them to birds/km³
  (η = 10^((dBZ + 13.37)/10) cm²/km³ over 11 cm² per bird), and lists a
  per-radar vertical profile of mean density with a VAD fit of ground speed
  and heading per 200 m bin, flagging daytime scans. No wind subtraction, so
  insects aren't separated.
- **Hydrograph** — clicking a reach or USGS gage opens a D3 hydrograph of that
  reach from every loaded run (each uploaded file plus the latest S3 load),
  with the gage's observed discharge when there is one. Toggle/isolate lines
  from the legend, scroll to zoom, drag to zoom to a range, shift-drag to pan,
  and hover for a readout of every line. KGE / NSE / r / PBIAS / RMSE are
  scored for each run against the observations and for any chosen pair of
  lines (with an optional A − B diff strip), over the visible time window.
- **Live routing (experimental)** — a Muskingum-Cunge "paintbrush": hold the
  mouse over rivers to add lateral inflow and watch it route downstream live.
  The kernel is [rs_route](https://github.com/CIROH-UA/rs_route)'s, compiled to
  WebAssembly; the network is whatever flowpath tiles are loaded, with channel
  parameters guessed from stream order. See `WASM_ROUTING.md`.

## Running

It's a static site with no build step, but it **must be served over HTTP(S)** —
it uses ES modules and a module Web Worker, which browsers won't load from
`file://`. Any static server works:

```sh
bun serve.js            # or: PORT=3000 bun serve.js
# then open http://localhost:8000/
```

`serve.js` is a small Bun static server for this folder. If you don't have Bun,
`python3 -m http.server 8000` works too.

The live-routing kernel is Rust (`wasm/mc_route`), but its wasm-pack output is
committed in `src/vendor/mc_route/`, so you only need Rust if you change it:

```sh
cargo test --manifest-path wasm/mc_route/Cargo.toml   # incl. parity vs rs_route
./build-wasm.sh                                       # rebuild src/vendor/mc_route/
```

Third-party libraries (MapLibre GL, PMTiles, D3) load from CDNs via `<script>` tags
in `index.html`; the data-parsing libraries (jsfive for NetCDF/HDF5, hyparquet
for Parquet) are imported on demand inside the parse worker.

You can deep-link to a location with `?bucket=<name>&path=<prefix>`.

## Project structure

Everything runs client-side. `src/main.js` is a thin entry point; the rest is
split into focused ES modules.

```
index.html                    markup + CDN <script>s; loads src/main.js as a module
src/
  main.js                     entry point — calls init() once the DOM is ready
  config.js                   shared constants (palette, variables, sentinels)
  state.js                    mutable singletons: state, s3State, and the map instance
  map/
    basemap-style.js          merges the hydrofabric layers into the base style
    init.js                   creates the map, binds map + DOM event listeners
    paint.js                  results paint expression + per-reach feature-state
    statepainter.js           on-screen feature-state painter (reaches + catchments)
    interactions.js           hover tooltip, click info, catchment click, upstream highlight
  color/
    scales.js                 continuous transforms (log, sqrt, symlog, …)
    breaks.js                 quantile / Jenks class breaks
    expressions.js            MapLibre color + width paint expressions
  s3/
    client.js                 S3 listing: fetch + XML parsing only (no DOM)
    browser.js                folder/breadcrumb/file-picker UI
  data/
    access.js                 valueAt/seriesAt accessors + derived-value cache
    sources.js                registry of loaded runs + active-dataset events
    metrics.js                series alignment + KGE / NSE / PBIAS / … (pure)
    usgs.js                   USGS gage metadata + observed discharge client
    diff.js                   A − B diff of two loaded runs
    loader.js                 load orchestration + the parse/merge worker pool
    workers/
      parse.worker.js         module worker hosting the parsers, merge + forcing fetches
      merge.js                mergeDatasets + bounds (worker-side, pure)
      hdf5layout.js           async HDF5 layout reader for forcing files (pure)
      forcing.js              forcing row fetch/decode over range requests (pure)
      nexrad.js               NEXRAD Level II records → per-tilt gate positions + bird profile sums (pure)
      bzip2.js                bzip2 decoder for the Level II records (pure)
      parsers/
        netcdf.js             NetCDF4/HDF5 parser (worker-side, pure)
        parquet.js            Parquet parser (worker-side, pure)
  ui/
    dom.js                    shared row/button builders + escaping (leaf)
    playback.js               play/pause/step transport
    panels.js                 data-info summary, legend, status lines
    time.js                   setTimeIndex() + current-timestep readout
    overview.js               basin-total sparkline + click-to-seek
    infopanel.js              reach click info panel
    gagepanel.js              gage click info panel (USGS station details)
    hydrograph.js             D3 hydrograph dock: runs vs obs, zoom, metrics
    forcingpanel.js           forcings sidebar panel: source, load buttons, controls
    forcingplot.js            per-catchment forcing small multiples (dock)
    contextmenu.js            map right-click menu
    nexradpanel.js            NEXRAD panel: date, per-station scan rows + lock, display controls
  forcing/
    store.js                  sparse, growable catchment store + change events
    layout.js                 per-file layout scan + IndexedDB cache
    loader.js                 load planning/orchestration (viewport, VPU, catchment)
    viewport.js               VPUs and catchments in view
    paint.js                  catchment fill expression + feature-state, forcing clock
  nexrad/
    source.js                 bucket listings, scan download, worker fan-out + tilt merge
    layer.js                  deck.gl PointCloudLayer per radar (lazy-loads deck.gl)
    products.js               moment labels, ranges, colour ramps
    birds.js                  bird-mode profile: density + VAD solve, sun elevation
    sites.js                  station dots/labels, click to pick
    stations.json             station table (GeoJSON), see its `source` field
  sim/
    network.js                live routing: reach collection, step loop, paint + panel
    sim.worker.js             owns the wasm Network; steps it off the main thread
    brush.js                  lateral-inflow brush cursor, sliders, deposits
  vendor/
    mc_route/                 wasm-pack output of wasm/mc_route (committed)
wasm/
  mc_route/                   Rust crate: vendored rs_route MC kernel + Network
```

### How data flows

1. `s3/browser.js` lists folders (`s3/client.js`) and hands a selected file URL
   to `data/loader.js`.
2. `loader.js` dispatches parsing to a bounded pool of module workers
   (`parse.worker.js`). Each worker fetches and decodes a file into
   feature-major `Float32Array` matrices; a CONUS load fans many files across
   the pool and merges them in a worker.
3. The parsed matrices are **transferred** (not copied) back to the main thread,
   which owns them from then on — so recoloring per timestep reads them
   synchronously without touching the worker again.
4. `loader.js` promotes the run to `state.data` and announces it
   (`emitActiveDatasetChange`); map, panels, gages, time and the overview each
   react to that event rather than being driven from the loader.
5. `map/paint.js` sets a paint expression once per variable/scale
   (`color/expressions.js`) and updates only the on-screen reaches' feature-state
   as the timestep or viewport changes. Seeks all go through
   `setTimeIndex()` in `ui/time.js`.
