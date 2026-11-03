// ====================================================================
// Water depth in an NWM reach's channel from its flow and velocity (stage
// option A in report.md): wetted area A = Q / v, inverted through the
// reach's RouteLink channel, which is the same compound section NWM's
// Muskingum–Cunge routing uses:
//
//   in bank   a trapezoid: bottom width Bw, side slope z = 1 / ChSlp
//             (ChSlp is rise/run), up to the bankfull depth where its top
//             is TopWdth: h_bf = (TopWdth − Bw) / (2z)
//   overbank  a rectangle TopWdthCC wide on top of that
//
// Pure: no DOM, no map, no state.
// ====================================================================

// The tiles' channel attributes for one reach, or null if it has none
// (z0–6 tiles carry only id + order).
export function channelOf(props) {
  const bw = +props.BtmWdth;
  const tw = +props.TopWdth;
  if (!(bw >= 0) || !(tw > 0)) return null;
  const chSlp = +props.ChSlp;
  // Side run per unit rise; a vertical-walled channel when ChSlp is missing.
  const z = chSlp > 0 ? 1 / chSlp : 0;
  const bf = z > 0 && tw > bw ? (tw - bw) / (2 * z) : Infinity;
  const twcc = +props.TopWdthCC > 0 ? +props.TopWdthCC : 3 * tw;
  return {
    bw: Math.max(bw, z > 0 ? 0 : tw), // a rectangle is as wide as its top
    z,
    bankfull: bf,
    bankfullArea: Number.isFinite(bf) ? (bw + z * bf) * bf : Infinity,
    twcc,
  };
}

// Depth (m) at which `ch` carries wetted area `area` (m²).
export function depthForArea(ch, area) {
  if (!(area > 0)) return 0;
  if (area <= ch.bankfullArea) {
    // z h² + Bw h − A = 0, in the form that's stable for small z (and exact
    // at z = 0).
    const disc = ch.bw * ch.bw + 4 * ch.z * area;
    const h = (2 * area) / (ch.bw + Math.sqrt(disc));
    return Number.isFinite(h) ? h : 0;
  }
  return ch.bankfull + (area - ch.bankfullArea) / ch.twcc;
}

// The flood stage (m above the DEM's drainage cell) for flow q (m³/s) at
// velocity v (m/s), or NaN without both. `from`:
//   "bankfull"  only the depth above bankfull: the DEM's channel cells are
//               taken as the bank, so in-bank flow floods nothing
//   "bed"       the whole depth, as if the DEM were the channel bed
export function stageFor(ch, q, v, from) {
  if (!ch || !(q >= 0) || !(v > 0)) return NaN;
  return stageForDepth(ch, depthForArea(ch, q / v), from);
}

// The same for a channel depth the run reports itself (an ngen t-route run's
// `depth`), measured against the channel `ch` crosswalked from NWM.
export function stageForDepth(ch, h, from) {
  if (!ch || !(h >= 0)) return NaN;
  if (from === "bed") return h;
  return Number.isFinite(ch.bankfull) ? Math.max(0, h - ch.bankfull) : 0;
}
