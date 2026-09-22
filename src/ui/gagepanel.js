// ====================================================================
// Gage click panel: the gage's USGS station details. Observed discharge is
// charted against every loaded run in the hydrograph dock.
// ====================================================================
import { state } from "../state.js";
import { fetchGageMeta } from "../data/usgs.js";
import { openHydrograph } from "./hydrograph.js";

// Bumped per click so a slow response for an earlier gage can't paint over
// the panel for the one clicked most recently.
let requestSeq = 0;

export async function showGageInfo(feature) {
  const site = String(feature.properties.hl_uri || "").replace(/^gages-/, "");
  const reachId = feature.properties.id;
  const row = state.data.index.get(reachId);
  const seq = ++requestSeq;

  document.getElementById("info-id").textContent = `USGS-${site}`;
  const content = document.getElementById("info-content");
  content.replaceChildren(infoRow("Reach", `wb-${reachId}`));
  document.getElementById("info-panel").classList.add("visible");
  state.selectedFeature = { id: reachId, row };

  openHydrograph({ reachId, site });

  let meta;
  try {
    meta = await fetchGageMeta(site);
  } catch {
    if (seq === requestSeq) content.append(infoRow("Station", "No USGS metadata"));
    return;
  }
  if (seq !== requestSeq) return;
  if (meta.name) content.append(infoRow("Station", meta.name));
  if (meta.siteType) content.append(infoRow("Type", meta.siteType));
  if (meta.drainageArea != null) {
    content.append(infoRow("Drainage", `${meta.drainageArea.toLocaleString()} mi²`));
  }
  if (meta.flow) {
    const day = (ms) => (ms == null ? "?" : new Date(ms).toISOString().slice(0, 10));
    content.append(infoRow("Q record", `${day(meta.flow.beginMs)} → ${day(meta.flow.endMs)}`));
  } else {
    content.append(infoRow("Discharge", "not continuous"));
  }
}

function infoRow(label, value) {
  const row = document.createElement("div");
  row.className = "info-row";
  const l = document.createElement("span");
  l.className = "info-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "info-value";
  v.textContent = value;
  row.append(l, v);
  return row;
}
