# How the flow particles work

The flow particles work like a wind map, but the vector field is the direction water flows downhill. Particles are dropped evenly over the screen and follow the terrain, so they collect into channels and the river network shows up without any river data. There are four stages.

## 1. Choosing what to route (`flow/field.js`)

The field is a single rectangular mosaic of DEM pixels. It covers the visible ground plus a 15% margin on each side, so small pans stay inside it.

- **Resolution:** it uses DEM pixels at the map's zoom plus `flowState.detail`. If that's more than `FLOW_MAX_CELLS`, it steps down a zoom level until it fits.
- **Pitched views:** ground more than 1.5 screen-widths from the centre is clipped, since it would be sub-pixel anyway.
- **When it rebuilds:** only when the current field (or the one already requested) doesn't cover what's on screen. Requests are debounced by 300 ms.
- **Fast first paint:** if the existing field covers less than 90% of the new view, it first requests a coarse field two zooms down (1/16 of the cells, mostly cached ancestor tiles). Particles appear straight away and the full-resolution field replaces it when ready.
- **Stale requests:** each request carries an epoch. The worker drops an outdated request after its tiles load and before the expensive routing step.

## 2. Building the mosaic (`flow/flow.worker.js`)

This runs in a dedicated worker, separate from the parse pool, because it keeps its own tile cache.

- **Tile source:** it reads the hillshade's raster-dem source config (tile URL, encoding, tile size) and fetches the same URLs MapLibre does, so tiles you've already viewed come from the HTTP cache. It doesn't use MapLibre's loaded tiles: those are private to MapLibre's workers and come at mixed zooms.
- **Decoding:** tiles are decoded with `createImageBitmap` with no colour conversion, and kept in an LRU of 96 tiles.
- **Fingerprinting protection:** some browsers perturb canvas pixel reads, and one flipped red byte becomes a 256 m elevation spike. If a probe detects this, pixels are read through `VideoFrame` instead.
- **Missing tiles:** a tile that 404s (past the data's maximum zoom) is filled from its nearest ancestor, bilinearly upsampled. The upsampling reads the ancestor's neighbouring tiles across its edges, so there are no flat strips or steps at coarse seams. Failed fetches (network or 5xx) are counted separately so the field gets retried later.
- **Cell sizes:** a per-row metres-per-cell array is passed along, because a Web Mercator cell shrinks with cos(latitude).

## 3. Routing the water (`data/workers/flowroute.js`, pure)

1. **Priority-Flood + ε (Barnes 2014).**
   - The flood starts from the grid edges and from every cell at or below 0 m or with no data. Those are outlets, so the sea and closed basins below sea level (Death Valley, the Salton Sink) absorb water instead of filling up.
   - Pits and flats are raised just enough that every cell has a strictly downhill path out. Lakes drain through their spill point.
2. **Re-picking receivers.**
   - The flood assigns each cell its *lowest* neighbour, which biases flow about 40° toward the diagonals on most slopes.
   - Each cell's receiver is re-picked as the steepest descent (drop divided by distance) on the filled surface.
   - On filled flats, where every drop is about ε, the flood's own receiver is kept, because it leads to the spill point.
3. **Flow accumulation:** upstream area is summed down the receiver tree in topological order (Kahn's algorithm). This is what makes the rivers stand out.
4. **Direction:** a blend of two directions.
   - On hillslopes it's the Horn 3×3 gradient of the filled surface, which is smooth rather than limited to 8 directions.
   - As accumulation grows (half-and-half at 24 cells) it shifts toward the direction of the cell **8 steps down the receiver chain**. Aiming at the immediate receiver makes the bilinearly sampled field stall where neighbouring receivers converge.
   - A final smoothing pass weights each neighbour by √acc. Only neighbours flowing roughly the same way count, so the two sides of a ridge don't cancel out.
5. **Slope:** √S, taking the larger of the gradient and the drop to the receiver. This is used for speed, since Manning's equation gives v ∝ S^½.

## 4. Packing the field (`data/workers/flowcells.js`)

- **Speed:** √slope, or in Manning mode √slope × area^`FLOW_MANNING_EXP`. It's normalised per field so the 90th percentile equals 1, then clamped to the range 0.04 to 3.
- **Cell records:** each cell is packed into one interleaved record `[dirX, dirY, ±speed, elev]`. A bilinear sample then touches two cache lines instead of one per array. Outlets store a negative speed, which is free because speed is always positive.
- **Colour:** a 0–255 lookup-table index, either log(upstream area) or speed.
- **Repacking:** the main thread re-runs this packing (without re-routing) when the speed model or colour mode changes.

## 5. Simulating and drawing (`flow/particles.js`, `flow/gpusim.js`)

**Spawning:**
- 17×17 points across the screen are converted back to map coordinates (Mercator). A new particle goes at a random spot in a random cell of that grid, so spawning is even on screen even when the camera is pitched.
- Particles never spawn on an outlet.
- Each particle gets a random lifetime from `FLOW_LIFE_FRAMES`.

**Stepping (CPU path):**
- Positions are stored in Mercator [0, 1] coordinates, so particles survive a field swap.
- Each frame, a particle bilinearly samples direction and speed, then moves `speed × flowState.speed` css px. That's converted to field cells using the current zoom, so on-screen speed doesn't depend on zoom.
- Moves are split into sub-steps of at most 0.75 cells (up to 6), so fast particles don't jump over ridges or channels.
- A particle dies when it leaves the field or its nearest cell is an outlet (the water has reached the sea), and respawns the next frame.
- Time is measured in 60 Hz frames, so speed doesn't depend on the display's refresh rate. A long gap, like a hidden tab, is capped at 3 frames.
- This step is the hot loop, so it's fully inlined with no per-sample property lookups.

**Height:** z is the DEM elevation × the terrain exaggeration, plus a small lift (`FLOW_LIFT_M`). With terrain off, z is just the lift.

**Trails:**
- Trails are a **ring of deck.gl `LineLayer`s**, one per frame. Each layer holds that frame's single segment per particle and fades through its layer `opacity` as it ages.
- Each frame writes and uploads only the newest layer. That layer always gets the spare buffer set, because deck only re-uploads an attribute when its typed array changes identity.
- Each particle also fades in over its first 12 frames and out over its last 12.
- When the field is smaller than about 2° across, positions are stored as offsets from its centre (`LNGLAT_OFFSETS`) so float32 keeps sub-metre precision at high zoom.

**GPU path (WebGPU only):** `gpusim.js` runs the same step as a WGSL compute shader on deck's own device, and nothing is uploaded per frame. The differences:
- **Positions:** stored as f32 field cells. When a new field lands they're remapped with `x·k + c`, where c is computed in f64.
- **Ring contents:** ring slots hold per-frame *positions* rather than segments. Slot i's layer draws from slot i−1 to slot i.
- **Spare slots:**
  - deck applies a new layer list only in its own animation-frame callback, but a camera move makes MapLibre redraw deck immediately with the previous list.
  - So the ring keeps two undrawn spare slots, and every slot is emitted each frame with a stable id. Dropped buffers are destroyed a few frames late.
- **Random numbers:** a hash of the particle index and the frame number.

On WebGL2, or if the compute pipeline fails to build, the CPU step is used. The two steps must be kept in sync.

`map/deck.js` gives the particles their own `MapboxOverlay`. An overlay redraws all of its layers when any one changes, and the particles change every frame, so sharing one would make every other mode's layers redraw too.

## UI (`ui/flowpanel.js`)

Opening the panel starts the particles and collapsing it stops them. The sliders and selects write to `flowState`, and each change does only the work it needs:
- **Colormap:** rebuilds the lookup table.
- **Speed model or colour mode:** repacks the cells.
- **Detail:** forces a field rebuild.
- **Trail length:** resizes the ring.
