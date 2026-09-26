// ====================================================================
// Click info panel for a reach: its value and hydrofabric attributes. The
// time series opens in the hydrograph dock, with the reach's USGS gage
// observations when one sits on it.
// ====================================================================
import { state } from "../state.js";
import { VARIABLES, isValid } from "../config.js";
import { valueAt } from "../data/access.js";
import { gageSiteForReach } from "../map/gages.js";
import { labeledRows } from "./dom.js";
import { openHydrograph } from "./hydrograph.js";

export function showFeatureInfo(feature) {
  const id = feature.id;
  const row = state.data.index.get(id);
  document.getElementById("info-id").textContent = `wb-${id}`;

  const { label, units } = VARIABLES[state.variable];
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

  openHydrograph({ reachId: id, site: gageSiteForReach(id) });
}
