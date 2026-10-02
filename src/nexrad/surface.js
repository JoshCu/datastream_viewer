// ====================================================================
// Bird mode's surface context from the loaded forcings: precipitation and
// 10 m wind on the catchment under a radar, at the forcing step nearest the
// scan. Precip flags rain the ρHV filter may have let through; the 10 m wind
// is shown only for reference — at night it's often decoupled from the
// winds aloft the birds fly in, so it isn't subtracted from the VAD.
// ====================================================================
import { map, forcingState } from "../state.js";
import { isValid } from "../config.js";
import { valueAt } from "../data/access.js";
import { catchmentAt } from "../forcing/viewport.js";
import { ensureCatchment } from "../forcing/loader.js";

const PRECIP_VARS = ["precip_rate", "APCP_surface"];
const U_VAR = "UGRD_10maboveground";
const V_VAR = "VGRD_10maboveground";
// Forcings are hourly; a scan further than this from any step gets nothing.
const MAX_GAP_MS = 60 * 60 * 1000;

function nearestStep(times, t) {
  let best = -1;
  times.forEach((x, i) => {
    if (best < 0 || Math.abs(x - t) < Math.abs(times[best] - t)) best = i;
  });
  return best >= 0 && Math.abs(times[best] - t) <= MAX_GAP_MS ? best : -1;
}

// { precip (mm/h), u, v (m/s) } — each null when missing — for the catchment
// under `site` at `time`, or null when no forcings cover it. The catchment
// must be rendered (on screen, zoom ≥ 4); its row is fetched if needed.
export async function surfaceAt(site, time) {
  if (!forcingState.run || !forcingState.files.size) return null;
  const point = map.project([site.lon, site.lat]);
  const cat = catchmentAt(point);
  if (cat?.id == null || !(await ensureCatchment(cat.id, point))) return null;
  const run = forcingState.run;
  const t = nearestStep(run.time, time);
  if (t < 0) return null;
  const row = run.index.get(cat.id);
  const read = (name) => {
    if (!run.variables.includes(name)) return null;
    const v = valueAt(name, row, t, run);
    return isValid(v) ? v : null;
  };
  const rate = read(PRECIP_VARS.find((v) => run.variables.includes(v)));
  return { precip: rate == null ? null : rate * 3600, u: read(U_VAR), v: read(V_VAR) };
}
