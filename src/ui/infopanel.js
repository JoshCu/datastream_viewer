// ====================================================================
// Click info panel for a reach: its value and hydrofabric attributes. The
// time series opens in the hydrograph dock, with the reach's USGS gage
// observations when one sits on it.
// ====================================================================
import { state } from "../state.js";
import { REACH_SETS, isValid, reachSetOf } from "../config.js";
import { valueAt, variableInfo } from "../data/access.js";
import { gageSiteForReach } from "../map/gages.js";
import { labeledRows } from "./dom.js";
import { openHydrograph } from "./hydrograph.js";

export function showFeatureInfo(feature) {
  const id = feature.id;
  const row = state.data.index.get(id);
  document.getElementById("info-id").textContent = reachSetOf(state.data).label(id, state.data);

  const { label, units } = variableInfo(state.variable);
  const value =
    row === undefined
      ? undefined
      : valueAt(state.variable, row, state.timeIndex);

  const rows = [
    [
      label,
      value !== undefined && isValid(value)
        ? `${value.toFixed(4)} ${units}`
        : "--",
    ],
  ];
  // Straight from the vector tile, so these are built as text nodes.
  for (const [key, val] of Object.entries(feature.properties || {})) {
    if (key === "id") continue;
    rows.push([key, val]);
  }

  document.getElementById("info-content").replaceChildren(labeledRows(rows));
  document.getElementById("info-panel").classList.add("visible");

  // An NWM reach names its USGS gage in the tile (`gages`, omitted when it
  // has none); hydrofabric gages come from the gage layer.
  const set = reachSetOf(state.data);
  const site =
    set === REACH_SETS.nwm
      ? feature.properties?.gages || null
      : set === REACH_SETS.grid
        ? null // grid cells have no gages
        : gageSiteForReach(id);
  openHydrograph({ reachId: id, site });
}
