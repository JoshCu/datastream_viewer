// ====================================================================
// Click info panel for a reach: its value and hydrofabric attributes. The
// time series opens in the hydrograph dock, with the reach's USGS gage
// observations when one sits on it.
// ====================================================================
import { state } from "../state.js";
import { VARIABLES } from "../config.js";
import { valueAt } from "../data/access.js";
import { gageSiteForReach } from "../map/gages.js";
import { openHydrograph } from "./hydrograph.js";

export function showFeatureInfo(feature) {
  const id = feature.id;
  const row = state.data.index.get(id);
  document.getElementById("info-id").textContent = `wb-${id}`;

  let html = "";
  const { label, units } = VARIABLES[state.variable];
  const value =
    row === undefined
      ? undefined
      : valueAt(state.variable, row, state.timeIndex);
  html += `<div class="info-row">
                        <span class="info-label">${label}</span>
                        <span class="info-value">${value !== undefined && value > -9998 ? value.toFixed(4) + " " + units : "--"}</span>
                    </div>`;

  for (const [key, val] of Object.entries(feature.properties || {})) {
    if (["id"].includes(key)) continue;
    html += `<div class="info-row">
                        <span class="info-label">${key}</span>
                        <span class="info-value">${val}</span>
                    </div>`;
  }

  document.getElementById("info-content").innerHTML = html;
  document.getElementById("info-panel").classList.add("visible");
  state.selectedFeature = { id, row };

  openHydrograph({ reachId: id, site: gageSiteForReach(id) });
}
