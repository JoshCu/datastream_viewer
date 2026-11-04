# Task list

Open work, by area. Background, file formats and reasoning for the NWM and FIM work are in [report.md](report.md); how finished features work is in [CLAUDE.md](CLAUDE.md), and git has the detail of what landed. Add new items where they belong, delete them once they land, and move answered questions into the report.

**Constraint:** the connection is slow. Range-read only the bytes needed, show a download estimate before any big load, and avoid whole-file fallbacks ([report: Summary](report.md#summary)).

## Weather grids from dynamical.org

Done: MRMS, IMERG Late and CHIRPS final, read through `icechunk-js` + `zarrita` in the parse pool (Rainfall panel, hydrograph strip, map credit). Tested end to end in headless Brave, on software GL.

- [ ] **Browser test on a real GPU**: playback smoothness of the rain image and catchment means, especially at a large view
- [ ] A load's window and product aren't in the URL (only `open=rain`), so a link doesn't reproduce it
- [ ] All three stores are north-up, so the south-up side of `rain/rain.js`'s row lookup has never run

### HRRR and URMA

Why: hourly HRRR maps are small (0.09 MB/hour for precipitation rate, measured) and HRRR helps drive NWM short-range forecasts, so the two pair well. URMA is NOAA's later surface analysis, run about six hours after each hour, with temperature, wind and more (6.1 MB/hour for 2 m temperature, measured). Maps need the **virtual** products, whose chunks are byte ranges in NOAA's GRIB files; time series can use the materialized `noaa-hrrr-analysis`, which needs no GRIB.

**Decide first:**

- [ ] Which GRIB packing each variable uses, HRRR and URMA, from a few messages. That decides the decoder: simple and complex packing are a small JS or Rust job, JPEG 2000 isn't
- [ ] Compile `gribberish` (the codec the stores name) to wasm with `build-wasm.sh`'s toolchain, or write a small decoder for only the packings found. Check its size and speed on one 1799 × 1059 frame
- [ ] Confirm in a browser that `icechunk-js` resolves a virtual chunk to a Range read. `noaa-hrrr-bdp-pds` passed a CORS + Range check; `noaa-urma-pds` has only had its bucket root checked. Its docs warn that a cross-origin redirect from the global S3 endpoint carries no CORS headers

**Reader (`data/workers/rain.js`, `data/rain.js`):**

- [ ] Register the `gribberish` codec with zarrita, including its `north_up` option and URMA's `scale_offset` (−273.15). These arrays are float64, and have no shards
- [ ] Measure a load without shard indexes: chunk lengths from the manifest if `icechunk-js` exposes them, else HEAD or an estimate from a sample frame
- [ ] A map read here is one whole-domain chunk per time step and can't be cut down to the view. So budget by frame (URMA: 6.1 MB/hour, 3.7M cells), crop after decoding, and rework `planRainLoad`, which assumes time blocks
- [ ] Forecast products are `init_time × lead_time`, not `time`: add a cycle picker (as in the NWM panel) and pass the extra dimension through the reader

**Map:**

- [ ] Project the Lambert Conformal grids. Read the parameters from each store's spatial reference, not constants. `rain/rain.js`'s row lookup only works for a lat/lon grid, so this needs a 2-D lookup or a WebGL warp
- [ ] Catchment means and the hover readout go through `cellAt` / `rasterize`, which assume a regular lat/lon grid: use the inverse projection
- [ ] Raise or rethink `RAIN_MAX_CELLS` (1.5M) for URMA's 3.7M cells, without per-frame cost getting out of hand. The JS loop may not keep up; the WebGL painter in `fim/gpupaint.js` is the model

**Variables (each has a colour ramp and range in `RAIN_PRODUCTS`, which should become a general list):**

- [ ] First set: HRRR `precipitation_rate_surface`, `composite_reflectivity`, `temperature_2m`; URMA `temperature_2m`, `wind_speed_10m`, `wind_gust_10m`
- [ ] Rotate `wind_u` / `wind_v` to compass directions before any arrows: they're along the grid's axes. Prefer URMA's `wind_speed_10m` and `wind_direction_10m` until then
- [ ] Mask the known quirks from the catalog pages: reflectivity's −10 dBZ no-echo floor, NaN where a feature is absent, HRRR files often missing before 2018-08, and changes at each HRRR version upgrade
- [ ] Label accumulation and rate fields as covering the hour ending at their timestamp (they come from forecast hour 1, instantaneous fields from hour 0)

**Hydrograph (no GRIB needed, could ship first):**

- [ ] Point series from the materialized `noaa-hrrr-analysis` through the existing reader, once a lon/lat can be projected to the store's x/y index. About 0.5–0.8 MB per 90 days for precipitation, 3–4 MB for temperature (measured). Temperature needs its own strip units, and a way to pick the variable
- [ ] Skip URMA here: it has no materialized store, so a point series is one whole GRIB frame per hour

**Wrapping up:**

- [ ] Take the credit wording from each dataset's catalog page, and check it for provider terms (HRRR's short form is "NOAA HRRR from dynamical.org"; URMA's isn't confirmed)
- [ ] Rename the Rainfall panel and `RAIN_*` if it becomes general weather
- [ ] `build.sh`: copy any new wasm next to the html, as for `mc_route_bg.wasm`
- [ ] Update CLAUDE.md and README

## NWM flowline tiles

Done: tiles generated to spec, second flowline source with hover/tooltip, per-dataset network, gage dots for NWM runs. [report: Part 1 §1](report.md#1-flowline-tiles-done)

- [ ] Id count = 2,776,734 and `to` chains end at 0. Needs every z12 tile (401 MB), so run it where bandwidth is cheap (e.g. against the build's `.fgb`/mbtiles), not from here.
- [ ] Decide on z7 tile weight (0.4–1.1 MB per tile): attributes from z8, or no order 1 at z7 ([report: Open questions](report.md#open-questions))
- [ ] **Browser test** of NWM-run gage dots (`map/gages.js`): hover and click name the COMID and open its hydrograph

## NWM forecasts

Done: all configurations load end to end, tested in the browser. [report: Operational NWM output](report.md#operational-nwm-output) · [Part 1 §2](report.md#2-forecast-loader-datanwmjs--a-worker-parser)

- [ ] The estimate assumes every chunk is fetched; it's high for a tiny subset (11.5 MB estimated vs 4.3 MB for 4 reaches). Fine for views, which hit every chunk.
- [ ] Hour reads run 6 at a time; tune `NWM_FETCH_CONCURRENCY` on the slow link

## NWM retrospective

Done: single-reach series in the hydrograph with a measured estimate, tested in the browser. [report: Retrospective 3.0](report.md#retrospective-30-chrtoutzarr) · [Part 1 §3](report.md#3-retrospective-loader)

- [ ] One reach-year is ~90 MB (14 chunks of 30,000 reaches each, up to 8 MB). CHANOBS is worse for long windows (~195 kB per hour → ~1.7 GB/year). This makes the offline re-chunk below the real fix for hydrographs
- [ ] Event-window map load (≤28 days, chunk-aligned) with a ~100–350 MB confirm and strided gather
- [ ] Decide: is an offline spatially ordered re-chunk (script in `scripts/`) worth hosting? ([report: Open questions](report.md#open-questions))

## Flood mapping

Done: HAND field, stage from an NWM or ngen run, GPU painter, half-resolution preview, flood panel. [report: Part 2](report.md#part-2-getting-fim-working)

- [ ] **Browser test** of the speed-ups: GPU painter draws (status ends "· GPU"), colours match the CPU path, the preview → full swap, playback smoothness on the laptop
- [ ] **Browser test** of ngen FIM. Open question: t-route's depth is on the hydrofabric's channel geometry, the bankfull subtracted is NWM's; if they disagree much, flow ÷ velocity through the NWM channel may be the more consistent stage (one-line switch in `runMode`)
- [ ] Validate against `ana_inundation_extent` for one event ([report: Part 1 §4](report.md#4-ui-and-wiring))
- [ ] Stage option B: DEM-derived SRC per reach in the worker, if A looks wrong

## Later / optional

- [ ] Use the crosswalk (now loaded by `ngenCrosswalk()`, outlets only) so `data/diff.js` can compare NWM against an ngen run
- [ ] Alaska / Hawaii / Puerto Rico domains
- [ ] GCS mirror fallback (check CORS preflight first)
