# NWM forecasts, retrospective & FIM in datastream_viewer — investigation report

2026-11-02 · Josh Cunningham. Copied from the [shared doc](https://claude.ai/artifact/Qoc1VvhykhXSfRHzMizbpp); this file is the one to keep up to date. Task tracking is in [todo.md](todo.md).

## Summary

NWM forecasts are cheap to add: fetch from the AWS mirror, not NOMADS, and range-read only `streamflow` (~1.7 MB per hour of CONUS). The retrospective costs much more, because its zarr chunks are sorted by COMID rather than by location. FIM is feasible client-side, but a single flat reference per flowpath will fail on most reaches. Computing real HAND in the flow worker costs almost nothing extra and works better.

- **Forecasts:** NOMADS sends no CORS headers, so the browser can't read it. `noaa-nwm-pds` on S3 serves the same bytes with `Access-Control-Allow-Origin: *` and Range support. Each `channel_rt` file covers one valid hour for all 2,776,734 reaches, so a run is N files rather than one matrix.
- **Retrospective:** `chrtout.zarr` chunks are 672 h × 30,000 reaches, zstd-compressed, ~1–4 MB each. COMID order isn't spatial, so any viewport touches nearly all 93 feature chunks: about 100–350 MB per 28-day window. Gage hydrographs can use the small `CHANOBS` files instead.
- **No depth:** NWM outputs no depth or stage, only `streamflow` and `velocity`. Depth comes from a rating curve, either NWM's own RouteLink channel geometry or one built from HAND.
- **FIM:** OWP's HAND rasters and `hydroTable.csv` are in a requester-pays bucket that needs ESIP credentials, so the browser can't use them. The flow worker already decodes a DEM mosaic and runs Priority-Flood, D8 and a Kahn pass. HAND plus a drainage-reach id per cell is one more O(N) pass on top of that.

**Recommended order:**

1. Bake RouteLink attributes into the NWM flowline PMTiles (done; see [Appendix: flowline PMTiles spec](#appendix-flowline-pmtiles-spec)).
2. Short-range forecast loader.
3. Analysis, medium and long range.
4. Retrospective for event windows and single-reach hydrographs.
5. FIM: HAND in the flow worker, then stage from RouteLink geometry, then a DEM-derived rating curve if needed.

**Bandwidth:** the user's connection is slow. Every loader should range-read the bytes it needs and estimate the download before starting; whole-file fallbacks are a last resort.

## Operational NWM output

Operational output is NWM v3.1: one NetCDF-4 file per configuration, cycle, lead time and output type. Details are from the 2026-11-02 cycles.

**Access**

| Host | CORS | Range | Retention |
| --- | --- | --- | --- |
| [nomads.ncep.noaa.gov/.../nwm/prod](https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwm/prod/) | none | yes | ~2 days (`nwm.20261102/`, `nwm.20261103/`) |
| [noaa-nwm-pds.s3.amazonaws.com](https://noaa-nwm-pds.s3.amazonaws.com/?list-type=2&prefix=nwm.&delimiter=/) | `*` | yes | `nwm.20250101/` onward |
| storage.googleapis.com/national-water-model | not returned | yes | not checked |

The path is `nwm.YYYYMMDD/<config>/nwm.tHHz.<config>.channel_rt[_N].<fNNN|tmNN>.conus.nc`, and S3 uses the same layout. NOMADS also has `v3.0/` (August 2026 only) and `v3.1/` trees, plus `post-processed/`.

**Channel products (CONUS)**

| Folder | Steps per cycle | Cycles/day | File size |
| --- | --- | --- | --- |
| `analysis_assim` | tm00–tm02 (hourly, looking back) | 24 | 12 MB |
| `analysis_assim_extend` / `_long` / `_no_da` | look-back variants | fewer | 12 MB |
| `short_range` | f001–f018 hourly | 24 | 12 MB |
| `medium_range_mem1` | f001–f240 hourly | 4 | 12 MB |
| `medium_range_mem2–6`, `_blend`, `_no_da` | ensemble / blended | 4 | 12 MB |
| `long_range_mem1–4` | f006, f012, … (6-hourly, ~30 days) | 4 | 4.5 MB |

Other `channel_rt` regions are `_alaska`, `_hawaii` and `_puertorico`. The `land`, `reservoir` and `terrain_rt` outputs sit next to them in the same folders.

**Inside a `channel_rt` file** (from `ncdump -hs` and `h5dump`)

- Dimensions: `feature_id = 2776734`, `time = 1` and `reference_time = 1`. `time` and `reference_time` are int **minutes since 1970-01-01 UTC**.
- `feature_id` is int64 NHDPlusV2 COMIDs, sorted ascending, in exactly the same order as the retrospective zarr. Load the id → row table once and reuse it.
- Variables are packed int32 with `scale_factor` 0.01 and `_FillValue` −999900, plus shuffle and deflate level 2. They're split into 3 chunks of 925,578 features each.
  - short / medium: `streamflow`, `nudge`, `velocity`, `qSfcLatRunoff`, `qBucket`, `qBtmVertRunoff`
  - long range: `streamflow`, `nudge`, `velocity`
- Compressed sizes in one short_range file: `streamflow` 1.70 MB, `velocity` 1.98 MB, `feature_id` 0.62 MB. A range read of `streamflow` alone is about 14% of the 12 MB file.
- There is no depth or stage variable.

**HDF5 layout** (superblock v2; data layout message v3; chunk index v1 B-tree)

Byte ranges of each chunk in `nwm.t00z.short_range.channel_rt.f001.conus.nc`:

| Dataset | Chunks (offset, compressed bytes) |
| --- | --- |
| `time`, `reference_time` | 40,734 (49), 40,783 (12) |
| `feature_id` | 6 chunks, 44,877 → 675,138 |
| `streamflow` | 675,138 (590,515) · 1,265,653 (520,237) · 1,785,890 (585,931) |
| `nudge` | 2,371,821 → 2,480,590 (~109 KB total) |
| `velocity` | 2,480,590 (665,580) · 3,146,170 (618,499) · 3,764,669 (699,670) |
| `qSfcLatRunoff`, `qBucket`, `qBtmVertRunoff` | 4,464,339 → end |

Object headers sit in the first ~44 KB. B-tree nodes are small and interleaved up to ~250 KB (the `streamflow` index is at 240,225). So each hour costs a few small metadata reads plus one Range read: 1.7 MB for flow only, or 3.8 MB for flow + nudge + velocity in a single merged request. Chunk offsets depend on the compressed sizes before them, so parse them per file, as with the forcing files.

Streamflow-only downloads come to about 31 MB for a short-range cycle (18 h), about 410 MB for a medium-range mem1 cycle (240 h), or about 135 MB taking every 3rd hour. The chunks span all of CONUS, so a smaller viewport doesn't reduce the download, only the decode.

## Retrospective 3.0 (chrtout.zarr)

The retrospective is a Zarr v2 store with consolidated metadata covering 385,704 hourly steps (1979-02-01 01:00 to early 2023). The bucket has `Access-Control-Allow-Origin: *`, so the browser can read it directly ([.zmetadata](https://noaa-nwm-retrospective-3-0-pds.s3.amazonaws.com/CONUS/zarr/chrtout.zarr/.zmetadata)).

| Array | Shape | Chunks | Type | Notes |
| --- | --- | --- | --- | --- |
| `streamflow`, `velocity` | 385704 × 2776734 | 672 × 30000 | int32, ×0.01 | fill −999900 |
| `q_lateral` | same | same | int32, ×0.1 | fill −99990 |
| `qSfcLatRunoff`, `qBucket`, `qBtmVertRunoff` | same | same | int32 | |
| `time` | 385704 | 672 | int64 | hours since 1979-02-01T01:00 |
| `feature_id` | 2776734 | 1 chunk | int64 | sorted COMID, same order as operational |
| `elevation`, `latitude`, `longitude`, `order`, `gage_id` | 2776734 | 1 chunk | | per-reach static |

- Every array is compressed with zstd level 9 and has no filters. Chunk keys are `var/<t>.<f>` (`.` separator), giving 574 time chunks × 93 feature chunks.
- Sampled chunk sizes: `streamflow/0.0` 3.9 MB, `300.40` 1.5 MB, `573.92` 1.1 MB, `velocity/300.40` 0.7 MB. Each chunk decompresses to 80.6 MB.
- **Spatial spread:** I measured each 30,000-reach chunk's bbox from `latitude`/`longitude`. The median spans 31° of longitude and 13° of latitude, so any viewport needs most of the 93 chunks.

| Request | Chunks | Download |
| --- | --- | --- |
| One reach, 28 days | 1 | ~1–4 MB |
| One reach, 1 year | 13 | ~20 MB |
| One reach, full record | 574 | ~0.6–2 GB |
| Any viewport, 28-day window | ~93 | ~100–350 MB, and 93 × 80 MB decompressed one at a time |

The hourly NetCDF copies (`CONUS/netcdf/CHRTOUT/YYYY/YYYYMMDDHH00.CHRTOUT_DOMAIN1`) are about 48.8 MB per hour, which is worse for the map. `CONUS/netcdf/CHANOBS/` is gage reaches only, at about 195 KB per hour.

The static `elevation` array (metres, per reach) is NWM's own reach elevation. It's a ready-made per-reach reference height to compare against DEM sampling.

## Part 1: showing NWM data on the map

Most of the pipeline already fits: an NWM run becomes an ordinary `state.data` dataset keyed by COMID, painted on a second flowline source. The two real problems are memory and range-reading chunked HDF5.

### 1. Flowline tiles (done)

The tiles are at `https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/pmtiles/nwm/flowpaths_attrs.pmtiles` and follow the [Appendix: flowline PMTiles spec](#appendix-flowline-pmtiles-spec) (as amended there): the integer COMID is the tile feature id, the source layer is `flowpaths`, the RouteLink attributes are baked in and orders are thinned at low zooms.

**Viewer side (done):** an `nwm-flowlines` source (`encoding: "mlt"`) with line + hover layers, off by default behind its own toggle (`layers=nwm`). Width comes from `TopWdth`, falling back to order below z7. `REACH_SETS` in `config.js` describes both networks; a dataset sets `reaches: "nwm"` to be painted on these tiles, and `map/paint.js` keeps one painter per network. The tooltip shows `COMID N` and the gage if there is one, even without a run loaded. A dataset may omit variables (no `depth` for NWM).

**Measured, 2026-11-02** (header, metadata and directories read with Range requests; a handful of tiles decoded with `@maplibre/mlt` 1.3.0):

- Header: tile type 6 (MLT), gzip tiles and directories, z0–12, 201,817 tiles, 1.16 GB. Generated by tippecanoe/tile-join 2.82 (z0–6 and z7–12 built separately and joined).
- Contents match the amended spec: z0–6 features have only `order`; z7+ have every attribute; `lake` and `gages` are absent rather than 0 or blank; z12 extent is 65,536; ids decode as plain numbers (max seen 1,180,001,479).
- Line direction spot check: Mississippi COMID 3624735 at St. Louis (z12) runs north → south, i.e. upstream → downstream.
- `ChSlp` is rise/run, so the trapezoid's z = 1 / `ChSlp`, as in WRF-Hydro and `SIM_CHANNEL_BY_ORDER`. With z = 1/ChSlp, COMID 7398311 (Bw 17.8, Tw 29.6, ChSlp 0.26) has a bankfull depth of 1.5 m and COMID 3624735 (Bw 193.3, Tw 322.2, ChSlp 0.09) 5.8 m. Read as run/rise, they would be 23 m and 716 m. `TopWdthCC` (= 3 × TopWdth) and `nCC` (= 2 × n) are populated in every z7+ feature sampled.

Tile sizes per zoom (gzipped bytes, from the directories):

| z | tiles | total | median | p95 | max |
| --- | --- | --- | --- | --- | --- |
| 0–2 | 4 | 0.3 MB | 50–88 KB | | 99 KB |
| 3 | 4 | 1.0 MB | 234 KB | 283 KB | 356 KB |
| 4 | 7 | 1.2 MB | 133 KB | 287 KB | 357 KB |
| 5 | 21 | 3.4 MB | 123 KB | 531 KB | 571 KB |
| 6 | 64 | 9.2 MB | 147 KB | 354 KB | 445 KB |
| 7 | 207 | 76 MB | 386 KB | 842 KB | 1,087 KB (7/32/51) |
| 8 | 717 | 94 MB | 128 KB | 281 KB | 355 KB |
| 9 | 2,664 | 124 MB | 45 KB | 99 KB | 160 KB |
| 10 | 10,121 | 168 MB | 16 KB | 34 KB | 63 KB |
| 11 | 38,810 | 223 MB | 5 KB | 12 KB | 27 KB |
| 12 | 149,198 | 401 MB | 3 KB | 5 KB | 19 KB |

z7 is the heavy zoom: every attribute starts there while order 1 is already shown, so a z7 view pulls several MB. On the slow connection, either start the attributes at z8 or keep z7 to orders ≥ 2. Order 1 is held at opacity 0 at z7 anyway.

### 2. Forecast loader (`data/nwm.js` + a worker parser)

1. **List** cycles and files from `noaa-nwm-pds` with ListObjectsV2, using the S3 client the browser already has. Add the bucket to the S3 browser and recognise `nwm.YYYYMMDD/<config>/` as a loadable run.
2. **Range-read `streamflow` and `velocity` only.** `data/workers/hdf5layout.js` handles contiguous datasets only, so it needs chunked layouts: data layout v3 with a v1 B-tree chunk index (see [HDF5 layout](#operational-nwm-output)). It then needs `DecompressionStream('deflate')` plus an unshuffle, about 20 lines. `feature_id` is identical in every file, so read it once. Avoid the jsfive whole-file fallback: 12 MB per hour.
3. **Decode per hour on the worker pool** (`runTask`): int32 × scale, −999900 → `FILL_VALUE`, minutes → epoch ms, `timeAbsolute: true`, `refTime` from `reference_time`.
4. **Keep only the rows needed.** A full CONUS matrix is 2.78M × nTimes × 4 B: about 200 MB per variable for short range and 2.7 GB for medium range. So the worker keeps a subset at decode time, picked by region (VPU/bbox) and/or minimum stream order. Medium range also gets a time stride (every 3 h). The panel estimates the size first, like the forcing panel's confirm.
5. **Variables.** NWM provides `flow` and `velocity`. `depth` is either missing or derived from RouteLink geometry (Part 2). Check which modules assume every key in `VARIABLE_KEYS` has a matrix.

### 3. Retrospective loader

- **Reader:** hand-roll it. Parse `.zmetadata`, fetch `var/t.f` chunks, and zstd-decode in the worker. A wasm zstd is the safer choice, since a pure-JS decoder is slow on 80 MB chunks. [zarrita.js](https://github.com/manzt/zarrita.js) from esm.sh is the alternative.
- **Gather:** chunks are time-major (672 rows × 30,000 reaches), so pulling a reach subset is a strided gather into the feature-major matrix.
- **Hydrograph:** a single-reach series for a chosen window (1 chunk per 28 days). This is a new fetch path beside `seriesAt`, because the reach isn't in a loaded dataset.
- **Map playback:** limit it to event windows of ≤28 days aligned to chunk boundaries, and confirm the ~100–350 MB first. To browse the retrospective freely, the fix is an offline re-chunk into spatially ordered chunks (Hilbert order of reach midpoints, or per VPU), hosted on your own bucket.
- **Gage obs:** the tiles' `gages` attribute, or the retrospective's `gage_id` array, links USGS sites to COMIDs for the hydrograph overlay. `CHANOBS` gives fast gage-only series.

### 4. UI and wiring

- An NWM panel, or an S3 browser entry, with configuration, cycle, ensemble member, region, time stride and an estimated download.
- Loading goes through `promote()` / `emitActiveDatasetChange`, so time, paint, overview and hydrograph work unchanged.
- Comparing against an ngen run needs a COMID ↔ `wb-N` crosswalk. The hydrofabric's network table has one. `data/diff.js` currently expects shared feature ids.
- For validation, [maps.water.noaa.gov/server/rest/services/nwm](https://maps.water.noaa.gov/server/rest/services/nwm?f=json) serves `ana_high_flow_magnitude`, `ana_inundation_extent` and others as MapServer/FeatureServer, and returns CORS for localhost.

## Synthetic rating curves and OWP HAND FIM

OWP's FIM turns a reach's flow into a stage with a synthetic rating curve (SRC). It then floods every DEM cell in that reach's HAND catchment whose height above nearest drainage is below the stage. The SRC is computed from HAND itself, so terrain and curve are consistent ([wiki](https://github.com/NOAA-OWP/inundation-mapping/wiki/04.-Synthetic-Rating-Curve-Enhancements)).

- **Base SRC:** for each HAND catchment (a `HydroID`, a sub-segment of an NWM reach), take stages every 0.5 ft. At each stage, take the flooded cells to get reach-averaged area, wetted perimeter and hydraulic radius, then apply Manning: Q = (1/n) A R^(2/3) S^(1/2).
- **Enhancements:** a roughness calibration (`src_roughness_optimization.py`) fits a Manning n per HydroID. It uses USGS rating curves and about 200 AHPS/USGS benchmark FIM sites, then spreads the result to HydroIDs on the same `feature_id` and up to 10 km downstream. Bankfull and variable-roughness modules are still in development. Uncorrected biases: no bathymetry, simplified roughness, and hydro-conditioning artifacts.
- **Outputs:** `hydroTable.csv` per HUC8 (HydroID, feature_id, stage, discharge_cms, ManningN / adjust_ManningN, …), plus HAND (`rem`) and catchment rasters. Several HydroIDs map to one `feature_id`, which is the NWM COMID.
- **Access:** the national outputs are in `s3://noaa-nws-owp-fim/hand_fim/`, which is **requester pays** and needs ESIP-issued credentials (anonymous access returns `AccessDenied`). Using them means mirroring a subset to your own bucket, a 10 m raster per HUC8.

My conclusion: copying OWP's data isn't worth it for this viewer. Computing HAND and an SRC yourself from Mapterhorn is cheap with code that already exists, and it covers any area at any zoom.

## Part 2: getting FIM working

Compute real HAND in the flow worker rather than one flat reference per flowpath. It costs one extra O(N) pass on the mosaic `flowroute.js` already builds. It also answers the question the flat approach can't: which reach does each cell belong to?

### Why a flat per-flowpath reference falls short

- **Reach drop exceeds stage.** A water plane at the downstream end's elevation plus stage is too low at the upstream end whenever the reach drops more than the stage (drop = `So` × `Length`). A 2 km reach at slope 0.002 drops 4 m, more than most flood stages. The upstream half stays dry, even in-channel, except on big, flat rivers.
- **It still needs a cell → reach assignment.** That means NHDPlus catchment polygons, which you don't have tiled, or a nearest-line rule that floods across ridges into the next valley.
- **It can't use the current flood panel.** `FLOOD_LAYER` is a `color-relief` layer whose ramp is a function of `["elevation"]` only. One expression can't hold a different level per area, so any per-reach method needs a new rendered layer either way.

| Approach | Reference per cell | Cell → reach | Steep reaches | Cost |
| --- | --- | --- | --- | --- |
| Flat plane per flowpath (downstream point) | one per reach | needs catchments | under-floods | trivial, plus a catchment source |
| HAND in the flow worker (recommended) | its own drainage cell | free (D8 trace) | correct | +1 O(N) pass per field |
| OWP HAND mirrored | its own drainage cell | HydroID raster | correct | requester-pays mirror, fixed 10 m, per HUC8 |

### Pipeline

1. **DEM mosaic:** reuse `flow/field.js` and `flow.worker.js` (same tiles, LRU, fingerprinting-safe decode, terrain edits via `deltasFor()`). FIM wants z12–z14 (about 30–10 m), so pick its own zoom rather than the particle field's.
2. **Burn NWM flowlines:** collect NWM flowline geometry from `querySourceFeatures`, as `sim/network.js` does. Rasterize COMIDs into the mosaic. Lower burned cells a few metres before Priority-Flood so D8 follows the NWM lines, which is what OWP's hydro-conditioning does.
3. **Route:** the existing Priority-Flood + ε and steepest-descent receivers in `data/workers/flowroute.js`.
4. **HAND pass:** walk cells in reverse Kahn order, outlets first. A burned cell sets `drainElev = dem`, `reach = its COMID`. Every other cell copies both from its receiver. HAND = raw DEM − `drainElev`. The result is a Float32 HAND grid plus a Uint32 reach-row grid, sent to the main thread once per field.
5. **Stage per reach per timestep:** from the loaded run's flow (see below). That's an array the length of the visible reaches.
6. **Depth image:** depth = stage[reach[cell]] − HAND[cell], kept where > 0. That's about 10 ms for 4M cells, so it can rerun every timestep during playback. Draw it as a MapLibre `canvas`/`image` source (drapes on 3D terrain) with a depth ramp matching `FLOOD_SHALLOW_COLOR` and `FLOOD_DEEP_COLOR`.

### Stage from flow: three options, simplest first

- **A. NWM's own state (start here).** NWM gives `streamflow` and `velocity`, so wetted area A = Q / v. RouteLink gives the channel: a trapezoid of `BtmWdth`, side slope `ChSlp` and top width `TopWdth`, with a compound floodplain of width `TopWdthCC` above bankfull. Inverting A for depth is a quadratic per section, which is exactly NWM's internal hydraulics. The DEM surface is roughly the low-flow water level, so flood with stage = depth(Q) − depth(Q_low). Q_low could be a fixed low percentile, or simply the bankfull depth so only overbank flow floods.
- **B. DEM-derived SRC in the worker (OWP's method).** For each reach, use its HAND cells to compute A(h), P(h) and R(h) at 0.15 m steps, then Q(h) by Manning with RouteLink `n`, `So` and `Length`. Invert per timestep. This is self-consistent with the terrain. It over-predicts stage at low flow (no bathymetry), and reaches cut by the mosaic edge get partial catchments.
- **C. Mirror OWP `hydroTable.csv`.** Calibrated n, but it needs ESIP credentials and a HydroID → COMID collapse.

Your instinct about precomputing holds. HAND needs the DEM, the filled surface and the D8 tree, and the worker builds all three anyway. Doing it per view adds about one pass, and it follows terrain edits for free.

## Open questions

- [x] HDF5 chunk index: `channel_rt` uses layout v3 with a v1 B-tree index. Still to check, with small Range reads only: whether chunk order and header size hold across configurations.
- [x] Region or stream-order subset for NWM loads: default is the COMIDs in the NWM flowline tiles loaded for the view, with a min-order option, plus "All CONUS". The tiles already thin by order with zoom, so a zoomed-out view is effectively a high-order CONUS subset.
- [ ] Does the GCS mirror send CORS for a real browser preflight? It's a fallback if S3 throttles.
- [ ] Retrospective: are event windows enough, or is an offline re-chunk worth hosting? Measured 2026-11-03: one reach for 2022 is 14 chunks, 89 MB (the Mississippi's feature block runs 6–8 MB per chunk). A store chunked for single-reach reads (e.g. full record × ~100 reaches, or one year × 1,000 reaches) would make a reach-year a few hundred kB.
- [x] zstd in the browser: zstddec (wasm) decodes an 80 MB chunk in 28–45 ms; fzstd (pure JS) 110–190 ms.
- [x] The retrospective's `feature_id` is identical, in order, to the operational files'.
- [x] Stage option A needs a Q_low per reach. Chose **bankfull depth** (2026-11-03): stage = depth(Q/v) − bankfull depth, so in-bank flow floods nothing; the panel can switch to the full depth above the channel bed instead. A retrospective-derived low flow would need the offline re-chunk.
- [x] `ChSlp` is rise/run (z = 1 / ChSlp), and `TopWdthCC` / `nCC` are populated (v3.1.6). See [Part 1 §1](#1-flowline-tiles-done).
- [ ] z7 NWM tiles are 0.4–1.1 MB each. Move the attributes to z8, or drop order 1 from z7?
- [ ] Validate FIM against `ana_inundation_extent` for one event.

## Appendix: flowline PMTiles spec

The requirements handed to the tile build.

**Amended for the build that shipped** (`map/pmtiles/nwm/flowpaths_attrs.pmtiles`). These override the original list below:

1. Tiles are **MLT, not MVT** (PMTiles tile type `mlt`, gzip). The viewer source needs `encoding: "mlt"` (MapLibre GL JS ≥ 5.12).
2. z0–6 tiles carry only the feature id and `order`; every other property starts at z7. Feature-state painting by id works at every zoom.
3. `lake` and `gages` are omitted when empty, not 0 or blank.
4. z12 tiles use extent 65,536, not 4,096.
5. Reaches shorter than one tile unit are missing at z0–11. All are present at z12.
6. `upstream_id` / `num_upstreams` are numbered over the NWM `to` tree, so they don't match the hydrofabric tiles' numbering.
7. Values come from RouteLink **v3.1.6**, not v3.0; the ids are the same.

Original requirements:

- **Output:** one PMTiles v3 file of MVT tiles (e.g. `nwm_flowlines.pmtiles`), hosted on S3 with CORS and Range enabled.
- **One feature per NWM reach:** every `link` in NWM v3.0 `RouteLink_CONUS.nc` (2,776,734), matching `feature_id` in `channel_rt` and the retrospective.
- **Feature id = integer COMID** as the tile feature id (tippecanoe `--use-attribute-for-id=comid`); values reach ~1.18e9.
- **Source layer `flowpaths`.**
- **Line direction upstream → downstream** (last vertex at the outlet).
- **No merging or coalescing of reaches;** tile-edge splits and simplification are fine.
- **No silent dropping** at zooms where an order is shown; raise that order's minzoom instead of `--drop-densest-as-needed`.
- **Zooms:** maxzoom 12; minzoom by `order`: ≥6 → 0, 4–5 → 3, 3 → 5, 2 → 6, 1 → 7.

| Property | RouteLink field | Units | Rounding |
| --- | --- | --- | --- |
| `order` | `order` | Strahler order | int |
| `to` | `to` | downstream COMID, 0 at an outlet | int |
| `Length` | `Length` | m | 1 m |
| `So` | `So` | m/m | 5 significant figures |
| `n` | `n` | Manning's n | 0.001 |
| `nCC` | `nCC` | floodplain Manning's n | 0.001 |
| `BtmWdth` | `BtmWdth` | m | 0.1 |
| `TopWdth` | `TopWdth` | m | 0.1 |
| `TopWdthCC` | `TopWdthCC` | m | 0.1 |
| `ChSlp` | `ChSlp` | side slope (record whether run/rise) | 0.01 |
| `alt` | `alt` | m | 0.1 |
| `lake` | `NHDWaterbodyComID` | 0 / omitted if none | int |
| `gages` | `gages` | USGS site number, trimmed; omitted if blank | string |

Optional: `upstream_id` + `num_upstreams` (nested-set DFS numbering over `to`, as in the hydrofabric `divides` tiles), and `zdn` (DEM elevation at the downstream end).

Acceptance checks: 2,776,734 distinct ids at maxzoom (or a list of missing ids with reasons); following `to` reaches 0 with no cycles; line direction spot-checked on large rivers; file size and largest tile per zoom reported.

## Sources

- [NOMADS NWM prod listing](https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwm/prod/), with headers and `ncdump`/`h5dump` of `nwm.t00z.short_range.channel_rt.f001.conus.nc` and `nwm.t00z.long_range.channel_rt_1.f006.conus.nc` (2026-11-02 cycle)
- [noaa-nwm-pds bucket](https://noaa-nwm-pds.s3.amazonaws.com/?list-type=2&prefix=nwm.&delimiter=/)
- [chrtout.zarr .zmetadata](https://noaa-nwm-retrospective-3-0-pds.s3.amazonaws.com/CONUS/zarr/chrtout.zarr/.zmetadata), plus sampled chunks `feature_id/0`, `latitude/0`, `longitude/0`, `streamflow/300.40`
- [OWP SRC enhancements wiki](https://github.com/NOAA-OWP/inundation-mapping/wiki/04.-Synthetic-Rating-Curve-Enhancements)
- [NWM v3.0 parameter README](https://www.nohrsc.noaa.gov/owp_files/nwm/nwm_parameters/README.v3.0.txt)
- [NOAA NWM map services](https://maps.water.noaa.gov/server/rest/services/nwm?f=json)
