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
  sparkline, and click-to-highlight upstream catchments.
- **Hydrograph** — clicking a reach or USGS gage opens a D3 hydrograph of that
  reach from every loaded run (each uploaded file plus the latest S3 load),
  with the gage's observed discharge when there is one. Toggle/isolate lines
  from the legend, scroll to zoom, drag to zoom to a range, shift-drag to pan,
  and hover for a readout of every line. KGE / NSE / r / PBIAS / RMSE are
  scored for each run against the observations and for any chosen pair of
  lines (with an optional A − B diff strip), over the visible time window.

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
    interactions.js           hover tooltip, click info, upstream highlight
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
      parse.worker.js         module worker hosting the parsers + merge
      merge.js                mergeDatasets + bounds (worker-side, pure)
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
