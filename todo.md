# NWM + FIM task list

Background, file formats and the reasoning behind each task are in [report.md](report.md); section links are given per task. Tick items off as they land, add new ones where they belong, and move answered questions into the report.

**Constraint:** the connection is slow. Range-read only the bytes needed, show a download estimate before any big load, and avoid whole-file fallbacks ([report: Summary](report.md#summary)).

## 0. Flowline tiles

- [x] Generate NWM flowline PMTiles to the spec ([report: Appendix](report.md#appendix-flowline-pmtiles-spec))
- [x] Tile sizes per zoom (from the PMTiles directories) and line direction spot check ([report: Part 1 §1](report.md#1-flowline-tiles-done))
- [ ] Id count = 2,776,734 and `to` chains end at 0. Needs every z12 tile (401 MB), so run it where bandwidth is cheap (e.g. against the build's `.fgb`/mbtiles), not from here.
- [x] `ChSlp` is rise/run (z = 1/ChSlp); `TopWdthCC` / `nCC` populated
- [ ] Decide on z7 tile weight (0.4–1.1 MB per tile): attributes from z8, or no order 1 at z7 ([report: Open questions](report.md#open-questions))

## 1. Map plumbing for a second flowline source

[report: Part 1 §1](report.md#1-flowline-tiles-done)

- [x] Add the `nwm-flowlines` source (`encoding: "mlt"`) and line + hover layers in `src/map/basemap-style.js`, with width from `TopWdth` in `src/map/flowpathstyle.js`
- [x] Add a layer toggle in `src/map/layerprefs.js` (`LAYER_DEFAULTS.nwm`) and the URL `layers=` key
- [x] Per-dataset network: `REACH_SETS` in `config.js` + `dataset.reaches` (`"nwm"`, absent = hydrofabric), one painter per network in `src/map/paint.js`, hover/tooltip/click/`reachAt` in `src/map/interactions.js`, wiring in `src/map/init.js`. `src/sim/*` stays on the hydrofabric.
- [x] Show the COMID (and `gages` if set) in the reach tooltip, with or without a run
- [x] Let a dataset omit a variable (`hasVariable` / `datasetVariables` in `data/access.js`; parsers, merge, diff skip missing ones; the picker disables them)
- [x] Update CLAUDE.md (data model / painting sections)
- [x] Check in a browser: MLT source renders, toggle, hover tooltip on both networks, a hydrofabric run still paints and clears (tested by Josh)
- [x] `map/gages.js`: an NWM run shows the gage dots whose site is the `gages` attribute of one of its reaches (gathered from loaded NWM tiles, so it grows as they stream in); hover and click name the COMID and open its hydrograph. Not yet browser-tested

## 2. Forecast loader

[report: Operational NWM output](report.md#operational-nwm-output) · [Part 1 §2](report.md#2-forecast-loader-datanwmjs--a-worker-parser)

- [x] Extend `src/data/workers/hdf5layout.js` to read chunked datasets: layout v3, v1 B-tree chunk index, filter pipeline, deflate (`DecompressionStream`) + unshuffle (`chunkList`, `decodeChunk`, `readRootDatasets`)
- [x] Layout checked across configurations with Range reads only: short (t00, t06 f018), analysis tm00, medium mem1 + blend, long mem1. Same vars/chunking; `feature_id` byte-identical (617,685 B); 2–3 metadata requests (~112 kB) per file
- [x] `src/data/nwm.js`: file names per configuration / cycle / member / step from `NWM_CONFIGS`; newest complete cycle by HEADing its last file (no XML listing)
- [x] Read `feature_id` once and cache it in IndexedDB, with its compressed size as a fingerprint re-checked per hour
- [x] `parse.worker.js` tasks `nwmIds`, `nwmSizes`, `nwmHour` (documented in the protocol)
- [x] Subset by file row at decode time; only the chunks with wanted rows are fetched. "Load viewport" (the reaches in the view's NWM tiles, which thin by order with zoom) and "Load CONUS" buttons; stride and analysis window are fixed per configuration (NWM_CONFIGS)
- [x] Download/memory estimate + confirm (`NWM_CONFIRM_BYTES`, 1 GB memory)
- [x] Promote as a normal dataset (`timeAbsolute`, `refTime` from `reference_time`, `reaches: "nwm"`)
- [x] short_range end to end outside the browser (bun, worker stubbed): 3 files, flow + velocity, 4.3 MB, values plausible
- [x] short_range end to end **in the browser** (tested by Josh, 2026-11-03)
- [x] analysis_assim: the tm00 files of the last N hourly cycles
- [x] medium_range members + blend with a time stride (default every 3rd file)
- [x] long_range members (6-hourly, default every 4th file = daily)
- [x] NWM Forecast panel + `nwm=` URL param
- [x] Hydrograph: an NWM reach's `gages` attribute supplies the USGS overlay
- [x] Update CLAUDE.md + README
- [ ] The estimate assumes every chunk is fetched; it's high for a tiny subset (11.5 MB estimated vs 4.3 MB for 4 reaches). Fine for views, which hit every chunk.
- [ ] Hour reads run 6 at a time; tune `NWM_FETCH_CONCURRENCY` on the slow link

## 3. Retrospective

[report: Retrospective 3.0](report.md#retrospective-30-chrtoutzarr) · [Part 1 §3](report.md#3-retrospective-loader)

- [x] zstd decoder: zstddec 0.3.4 (wasm, 76 kB ESM from jsDelivr), 28–45 ms per 80 MB chunk vs 110–190 ms for fzstd; loaded lazily in `parse.worker.js`
- [x] Minimal zarr reader (`data/workers/retro.js`): `var/t.f` chunk fetch, int32 × 0.01, fill −999900, hourly time from 1979-02-01T01:00. Layout constants in `config.js` from `.zmetadata` (not fetched at runtime)
- [x] Retro `feature_id` = operational COMID list, same order (all 2,776,734 compared), so the cached operational table gives the column
- [x] Single-reach hydrograph for a chosen window, HEAD-measured estimate first; NWM reaches clickable without a run
- [x] USGS obs overlay on NWM reaches via the tiles' `gages` attribute
- [x] Browser test of the retrospective section (Josh, 2026-11-03)
- [ ] One reach-year is ~90 MB (14 chunks of 30,000 reaches each, up to 8 MB). CHANOBS is worse for long windows (~195 kB per hour → ~1.7 GB/year). This makes the offline re-chunk below the real fix for hydrographs
- [ ] Event-window map load (≤28 days, chunk-aligned) with a ~100–350 MB confirm and strided gather
- [ ] Decide: is an offline spatially ordered re-chunk (script in `scripts/`) worth hosting? ([report: Open questions](report.md#open-questions))

## 4. FIM

[report: Part 2](report.md#part-2-getting-fim-working)

- [x] FIM field: `src/fim/fim.js` plans its own box at a DEM zoom tied to the map's (`FIM_MIN_ZOOM` 11 – `FIM_MAX_ZOOM` 14 in 512 px tiles, ≤ 4M cells, ≤ 4096 px a side) and sends a `hand` request to its own `flow.worker.js` instance (shared mosaic code + terrain deltas; not the particle worker's tile LRU, which comes and goes with the flow panel; tiles are HTTP-cache hits). Rebuilt after a move only when the view leaves it or its zoom changes
- [x] Rasterize NWM flowlines (every reach in the loaded tiles, 8-connected, higher order wins a shared cell) and burn them 10 m before Priority-Flood
- [x] Pure `src/data/workers/hand.js`: `drainageTree()` (split out of `flowroute.js`, `routeFlow` output checked bit-identical) + reverse-topological pass → Float32 HAND + Uint32 reach number per cell. Synthetic V-valley test gives HAND = side slope × distance
- [x] Stage option A (`src/fim/stage.js`): A = Q / v through the trapezoid + `TopWdthCC` floodplain; Q_low = **bankfull** by default (stage = depth − bankfull depth, so in-bank flow floods nothing), "channel bed" (full depth) as the alternative in the panel
- [x] Depth image on a runtime canvas source (`FIM_SOURCE`), repainted through `onTimeChange` (new subscription in `ui/time.js`) and on run change; flooded km² in the status
- [x] Flood panel: "Water from: a flat level / the NWM run" (`src/ui/floodpanel.js`); hover shows elevation, drainage COMID, HAND, stage and depth
- [x] Browser test of the NWM-run mode (Josh, 2026-11-03): works, a little slow on the laptop
- [x] Speed, HAND: `drainageTree`'s flood uses an inlined bucket queue (1/256 m bins) instead of a binary heap, interior cells skip bounds checks, no `closed` array: 4M synthetic cells 1.8 s → ~1.0 s (bun/node). What's left is memory-bound (the flood visits cells in elevation order), so not a GPU job. Particle `routeFlow` ~25% faster too; mean direction cosine vs the heap version 0.9999
- [x] Speed, first image: fields over 1.5M cells get a half-resolution HAND preview from the same mosaic (no extra tiles), then the full one
- [x] Speed, per timestep: WebGL2 painter (`src/fim/gpupaint.js`): HAND + reach textures once per field, a small stage texture per step, depth + colour in a shader; the canvas source copies GPU → GPU. CPU path kept as the fallback; the km² readout is counted only once the clock stops
- [ ] **Browser test** of the speed-ups: GPU painter draws (status ends "· GPU"), colours match the CPU path, the preview → full swap, playback smoothness on the laptop
- [x] FIM for an ngen run (`src/fim/fim.js`): NWM lines are still the ones burned in; each COMID's stage comes from its **outlet** wb-N in the NextGen ↔ NWM crosswalk (`nextgen_nwm_crosswalk.parquet`: 828,288 flowpaths → 818,901 COMIDs, exactly one `nwm_outlet` per COMID), using t-route's `depth` (else flow ÷ velocity) against the NWM channel's bankfull. Crosswalk read in the parse worker (hyparquet + zstddec, one 2.4 MB GET, checked in node) and cached in IndexedDB. An invisible loader layer keeps NWM tiles loading without turning the NWM lines on
- [ ] **Browser test** of ngen FIM. Open question: t-route's depth is on the hydrofabric's channel geometry, the bankfull subtracted is NWM's; if they disagree much, flow ÷ velocity through the NWM channel may be the more consistent stage (one-line switch in `runMode`)
- [ ] Validate against `ana_inundation_extent` for one event ([report: Part 1 §4](report.md#4-ui-and-wiring))
- [ ] Stage option B: DEM-derived SRC per reach in the worker, if A looks wrong
- [x] Update CLAUDE.md + README

## Later / optional

- [ ] Use the crosswalk (now loaded by `ngenCrosswalk()`, outlets only) so `data/diff.js` can compare NWM against an ngen run
- [ ] Alaska / Hawaii / Puerto Rico domains
- [ ] GCS mirror fallback (check CORS preflight first)
