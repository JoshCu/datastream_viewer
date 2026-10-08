// ====================================================================
// Gage click panel: the gage's USGS station details. Observed discharge is
// charted against every loaded run in the hydrograph dock.
// ====================================================================
import { siteFromGageFeature } from "../map/gages.js";
import { fetchGageMeta } from "../data/usgs.js";
import { getCatalog, siteTypes } from "../data/usgscatalog.js";
import { USGS_OBS_TYPES } from "../config.js";
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

// A catalog site (data/usgscatalog.js) with no run reach to chart against:
// its station details and, per observation type, the span of its record.
export function showSiteInfo(id) {
  const site = getCatalog()?.byId.get(id);
  if (!site) return;
  ++requestSeq; // a gage lookup still in flight mustn't paint over this

  document.getElementById("info-id").textContent = site.id;
  const content = document.getElementById("info-content");
  content.replaceChildren(labeledRow("Station", site.name));
  if (site.siteType) content.append(labeledRow("Type", site.siteType));
  if (!site.active) content.append(labeledRow("Status", "not reporting"));
  if (site.area != null) {
    content.append(labeledRow("Drainage", `${site.area.toLocaleString()} mi²`));
  }
  const { params } = getCatalog();
  for (const t of siteTypes(site)) {
    let begin = Infinity;
    let end = -Infinity;
    for (const [p, b, e] of site.series) {
      if (params[p].type !== t) continue;
      if (b != null && b < begin) begin = b;
      if (e != null && e > end) end = e;
    }
    const span = Number.isFinite(begin) ? `${fmtDay(begin)} → ${fmtDay(end)}` : "-";
    content.append(labeledRow(USGS_OBS_TYPES[t].label, span));
  }
  if (site.id.startsWith("USGS-")) {
    const link = document.createElement("a");
    link.className = "info-link";
    link.href = `https://waterdata.usgs.gov/monitoring-location/${site.id}/`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "USGS station page ↗";
    content.append(link);
  }
  document.getElementById("info-panel").classList.add("visible");
}
