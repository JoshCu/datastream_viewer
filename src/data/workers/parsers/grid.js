// ====================================================================
// Gridded output parser (worker-side, pure): the qkrig product in
// outputs/qkrig/qkrig.YYYYMMDD/HH/interp_YYYY-MM-DD_HH.nc.
//
// Each file is one hour of USGS streamflow kriged onto a regular lat/lon
// grid (normalised by drainage area, so mm/h):
//   z_interp(lat, lon)          float32, NaN outside the kriged area
//   kriging_variance(lat, lon)  float32 (not loaded)
//   lat(lat), lon(lon)          float64 cell centres, lat south → north
//   global attrs date = "YYYY-MM-DD", hour = H
// There is no time variable; the hour comes from the attributes (else the
// file name).
//
// The grid becomes an ordinary dataset whose "features" are its cells:
// id = latRow * nLon + lonCol + 1 (0 is avoided, as a feature id), on the
// `grid` reach set (config.REACH_SETS), with the cell centres in `grid` so
// the main thread can draw the cells (map/grid.js). Only cells with a value
// are kept; mergeDatasets() unions them across hours, so a cell missing in
// one hour is fill there.
// ====================================================================

// Whether an opened HDF5 file is a qkrig grid.
export function isGridFile(file) {
  return (file.keys || []).includes("z_interp");
}

const first = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v);

// Epoch ms of the hour the file covers, or undefined.
function gridTime(file, filename) {
  const date = file.attrs?.date;
  const hour = Number(first(file.attrs?.hour));
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(hour)) {
    return Date.parse(`${date}T00:00:00Z`) + hour * 3600e3;
  }
  const m = filename?.match(/(\d{4}-\d{2}-\d{2})_(\d{2})/);
  return m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) : undefined;
}

// "mm/hr" → "mm/h"; anything else as the file says.
function unitsOf(dataset) {
  let units = "mm/h";
  try {
    const u = dataset.attrs?.units;
    if (typeof u === "string" && u) units = u;
  } catch {
    // jsfive can't decode every attribute type; the units are known anyway.
  }
  return units.replace(/\/hr$/, "/h");
}

export function parseGridFile(file, filename) {
  const z = file.get("z_interp");
  const [nLat, nLon] = z.shape;
  const values = z.value;
  const lat = Float64Array.from(file.get("lat").value);
  const lon = Float64Array.from(file.get("lon").value);
  if (lat.length !== nLat || lon.length !== nLon) throw new Error("qkrig grid: lat/lon don't match z_interp");

  const t = gridTime(file, filename);
  const timeAbsolute = t !== undefined;
  const featureIds = [];
  const flow = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      featureIds.push(i + 1);
      flow.push(v);
    }
  }
  return {
    time: [timeAbsolute ? t : 0],
    timeAbsolute,
    nTimes: 1,
    featureIds,
    // The kriged value goes in the flow slot; `variableInfo` relabels it.
    matrices: { flow: Float32Array.from(flow) },
    refTime: timeAbsolute ? new Date(t).toISOString() : undefined,
    reaches: "grid",
    grid: { lat, lon },
    variableInfo: { flow: { label: "Streamflow", units: unitsOf(z) } },
  };
}
