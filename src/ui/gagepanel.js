// ====================================================================
// Gage click panel: the gage's USGS station details. Observed discharge is
// charted against every loaded run in the hydrograph dock.
// ====================================================================
import { siteFromGageFeature } from "../map/gages.js";
import { fetchGageMeta } from "../data/usgs.js";
import { labeledRow, fmtDay } from "./dom.js";
import { openHydrograph } from "./hydrograph.js";

// Bumped per click so a slow response for an earlier gage can't paint over
// the panel for the one clicked most recently.
let requestSeq = 0;

export async function showGageInfo(feature) {
  const site = siteFromGageFeature(feature);
  const reachId = feature.properties.id;
  const seq = ++requestSeq;

  document.getElementById("info-id").textContent = `USGS-${site}`;
  const content = document.getElementById("info-content");
  content.replaceChildren(labeledRow("Reach", `wb-${reachId}`));
  document.getElementById("info-panel").classList.add("visible");

  openHydrograph({ reachId, site });

  let meta;
  try {
    meta = await fetchGageMeta(site);
  } catch {
    if (seq === requestSeq) content.append(labeledRow("Station", "No USGS metadata"));
    return;
  }
  if (seq !== requestSeq) return;
  if (meta.name) content.append(labeledRow("Station", meta.name));
  if (meta.siteType) content.append(labeledRow("Type", meta.siteType));
  if (meta.drainageArea != null) {
    content.append(labeledRow("Drainage", `${meta.drainageArea.toLocaleString()} mi²`));
  }
  if (meta.flow) {
    content.append(
      labeledRow(
        "Q record",
        `${fmtDay(meta.flow.beginMs)} → ${fmtDay(meta.flow.endMs)}`,
      ),
    );
  } else {
    content.append(labeledRow("Discharge", "not continuous"));
  }
}
