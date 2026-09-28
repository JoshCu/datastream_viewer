// ====================================================================
// Forcing plot dock: every forcing variable of one catchment, as small
// multiples on a shared time axis (precipitation as bars, the rest lines).
//
//   - hover any panel: a crosshair across all of them, and each header
//     shows its value at that time
//   - click: seek the map's forcing timestep there
//   - the dashed marker follows the forcing timestep
//
// Shares the hydrograph dock's frame and styles; opening one closes the
// other (they're told apart through the "dockopen" event). A catchment that
// isn't loaded yet is fetched on its own — one row per variable — so the
// plot never needs a viewport load first.
// d3 is a global provided by the CDN <script> in index.html.
// ====================================================================
import { forcingState, map } from "../state.js";
import { CURRENT_TIME_COLOR, HIDDEN_FILTER, SERIES_COLORS, forcingMeta } from "../config.js";
import { seriesAt } from "../data/access.js";
import { ensureCatchment } from "../forcing/loader.js";
import { onForcingChange } from "../forcing/store.js";
import { setForcingTimeIndex } from "../forcing/paint.js";

const MARGIN = { top: 6, right: 10, bottom: 18, left: 46 };
const LINE_COLOR = SERIES_COLORS[0];
const BAR_COLOR = SERIES_COLORS[2];
const SELECTED_LAYER = "forcing-selected";

const view = {
  id: null, // catchment on show (numeric cat id)
  point: null, // where it was clicked, to narrow the VPU search on reload
  times: null, // epoch ms
  panels: [], // [{ name, meta, cell, valueEl, svg, values }]
  hoverIndex: null,
};

let els = null;
let requestSeq = 0; // guards the on-demand fetch against a newer target
let renderQueued = false;

const fmtTime = d3.utcFormat("%Y-%m-%d %H:%M UTC");

function fmtValue(v) {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1000) return d3.format(",.0f")(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1 || a === 0) return v.toFixed(2);
  return v.toPrecision(2);
}

export function setupForcingPlot() {
  const $ = (id) => document.getElementById(id);
  els = {
    dock: $("forcing-dock"),
    title: $("forcing-title"),
    subtitle: $("forcing-subtitle"),
    status: $("forcing-plot-status"),
    grid: $("forcing-grid"),
    empty: $("forcing-empty"),
  };
  $("forcing-close").addEventListener("click", closeForcingPlot);
  document.addEventListener("dockopen", (e) => {
    if (e.detail !== "forcing") closeForcingPlot();
  });
  new ResizeObserver(scheduleRender).observe(els.grid);

  onForcingChange(({ kind }) => {
    if (view.id == null) return;
    if (kind === "time") drawMarkers();
    else if (kind === "sources") load(); // a new cycle: same catchment, new files
    else if (kind === "rows" || kind === "run") rebuild();
  });
}

export function openForcingPlot(id, point = null) {
  // Before this dock claims the shared body class, so the other dock's close
  // doesn't strip it afterwards.
  document.dispatchEvent(new CustomEvent("dockopen", { detail: "forcing" }));
  view.id = id;
  view.point = point;
  view.hoverIndex = null;
  els.title.textContent = `cat-${id}`;
  els.dock.classList.add("visible");
  document.body.classList.add("hydro-open");
  if (map.getLayer(SELECTED_LAYER)) map.setFilter(SELECTED_LAYER, ["==", ["id"], id]);
  load();
}

export function closeForcingPlot() {
  if (view.id == null) return;
  view.id = null;
  requestSeq++;
  els.dock.classList.remove("visible");
  document.body.classList.remove("hydro-open");
  if (map.getLayer(SELECTED_LAYER)) map.setFilter(SELECTED_LAYER, HIDDEN_FILTER);
}

// Show the catchment, fetching its row first when the run doesn't have it.
async function load() {
  const seq = ++requestSeq;
  const id = view.id;
  els.subtitle.textContent = forcingState.sourceLabel ?? "";
  if (forcingState.run?.index.has(id)) {
    rebuild();
    return;
  }
  if (!forcingState.files.size) {
    showEmpty("Pick a forcing cycle or drop a forcing file in the Forcings panel.");
    return;
  }
  showEmpty("Loading forcings…");
  els.status.textContent = "";
  try {
    const found = await ensureCatchment(id, view.point);
    if (seq !== requestSeq) return;
    if (!found) showEmpty(`cat-${id} isn't in the forcing files for this source.`);
    else rebuild();
  } catch (err) {
    if (seq !== requestSeq) return;
    console.error("Forcing fetch error:", err);
    showEmpty(`Couldn't load forcings: ${err.message}`);
  }
}

function showEmpty(text) {
  view.panels = [];
  els.grid.replaceChildren();
  els.empty.textContent = text;
  els.empty.style.display = "flex";
}

// ---- Series + panels ---------------------------------------------------

function rebuild() {
  const run = forcingState.run;
  if (view.id == null || !run?.index.has(view.id)) return;
  els.empty.style.display = "none";

  const times = run.time;
  view.times = times;
  els.status.textContent =
    `${times.length} steps · ${fmtTime(new Date(times[0]))} → ${fmtTime(new Date(times.at(-1)))}`;

  // Rebuild the cells only when the variable set changed; otherwise the
  // existing SVGs just get new data.
  const names = run.variables;
  if (view.panels.map((p) => p.name).join() !== names.join()) {
    view.panels = names.map((name) => buildPanel(name));
    els.grid.replaceChildren(...view.panels.map((p) => p.cell));
  }
  for (const p of view.panels) {
    const s = seriesAt(run, view.id, p.name);
    const { scale, offset } = p.meta;
    p.values = Float64Array.from(s.values, (v) => v * scale + offset);
  }
  scheduleRender();
}

function buildPanel(name) {
  const meta = forcingMeta(name);
  const cell = document.createElement("div");
  cell.className = "forcing-cell";
  const head = document.createElement("div");
  head.className = "forcing-cell-head";
  const label = document.createElement("span");
  label.className = "forcing-cell-label";
  label.textContent = meta.units ? `${meta.label} (${meta.units})` : meta.label;
  label.title = name;
  const valueEl = document.createElement("span");
  valueEl.className = "forcing-cell-value";
  head.append(label, valueEl);

  const holder = document.createElement("div");
  holder.className = "forcing-cell-chart";
  cell.append(head, holder);

  const svg = d3.select(holder).append("svg").attr("class", "hydro-svg");
  const root = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);
  const panel = {
    name,
    meta,
    cell,
    holder,
    valueEl,
    svg,
    values: null,
    geom: null,
    g: {
      yAxis: root.append("g").attr("class", "hydro-axis hydro-axis-y"),
      xAxis: root.append("g").attr("class", "hydro-axis hydro-axis-x"),
      marks: root.append("g"),
      now: root.append("line").attr("class", "hydro-now").attr("stroke", CURRENT_TIME_COLOR),
      cross: root.append("line").attr("class", "hydro-crosshair").style("display", "none"),
      hit: root.append("rect").attr("fill", "transparent"),
    },
  };
  panel.g.hit
    .on("pointermove", (e) => {
      if (!panel.geom) return;
      const [px] = d3.pointer(e);
      view.hoverIndex = nearestIndex(panel.geom.x.invert(px).getTime());
      drawMarkers();
    })
    .on("pointerleave", () => {
      view.hoverIndex = null;
      drawMarkers();
    })
    .on("click", (e) => {
      if (!panel.geom) return;
      const [px] = d3.pointer(e);
      setForcingTimeIndex(nearestIndex(panel.geom.x.invert(px).getTime()));
    });
  return panel;
}

function nearestIndex(ms) {
  const t = view.times;
  const i = d3.bisectLeft(t, ms);
  if (i <= 0) return 0;
  if (i >= t.length) return t.length - 1;
  return ms - t[i - 1] < t[i] - ms ? i - 1 : i;
}

// ---- Rendering ---------------------------------------------------------

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  if (view.id == null || !view.times) return;
  const times = view.times;
  const step = times.length > 1 ? times[1] - times[0] : 3600e3;
  // Half a step of room either side, so end bars aren't cut in half.
  const domain = [new Date(times[0] - step / 2), new Date(times.at(-1) + step / 2)];

  for (const p of view.panels) {
    const width = p.holder.clientWidth;
    const height = p.holder.clientHeight;
    if (!width || !height || !p.values) continue;
    p.svg.attr("width", width).attr("height", height);
    const w = Math.max(10, width - MARGIN.left - MARGIN.right);
    const h = Math.max(10, height - MARGIN.top - MARGIN.bottom);

    const x = d3.scaleUtc().domain(domain).range([0, w]);
    let [lo, hi] = d3.extent(p.values.filter(Number.isFinite));
    if (lo === undefined) [lo, hi] = [0, 1];
    if (p.meta.bars) lo = Math.min(0, lo);
    // A flat series (a dry spell) still needs a span; bars keep their floor.
    if (hi - lo < 1e-9) [lo, hi] = p.meta.bars ? [0, Math.max(1, hi)] : [lo - 1, hi + 1];
    const y = d3.scaleLinear().domain([lo, hi]).nice(3).range([h, 0]);
    p.geom = { x, y, w, h };

    p.g.yAxis.call(d3.axisLeft(y).ticks(3).tickSize(-w).tickFormat(fmtValue));
    p.g.yAxis.select(".domain").remove();
    p.g.xAxis
      .attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(w / 90))).tickSizeOuter(0));
    p.g.hit.attr("width", w).attr("height", h);
    p.g.now.attr("y1", 0).attr("y2", h);
    p.g.cross.attr("y1", 0).attr("y2", h);

    const idx = d3.range(times.length).filter((i) => Number.isFinite(p.values[i]));
    if (p.meta.bars) {
      const bw = Math.max(1, (x(new Date(times[0] + step)) - x(new Date(times[0]))) * 0.8);
      p.g.marks
        .selectAll("path")
        .remove();
      p.g.marks
        .selectAll("rect")
        .data(idx)
        .join("rect")
        .attr("fill", BAR_COLOR)
        .attr("x", (i) => x(new Date(times[i])) - bw / 2)
        .attr("width", bw)
        .attr("y", (i) => Math.min(y(p.values[i]), y(0)))
        .attr("height", (i) => Math.abs(y(0) - y(p.values[i])));
    } else {
      p.g.marks.selectAll("rect").remove();
      const line = d3
        .line()
        .defined((i) => Number.isFinite(p.values[i]))
        .x((i) => x(new Date(times[i])))
        .y((i) => y(p.values[i]));
      p.g.marks
        .selectAll("path")
        .data([d3.range(times.length)])
        .join("path")
        .attr("fill", "none")
        .attr("stroke", LINE_COLOR)
        .attr("stroke-width", 1.5)
        .attr("d", line);
    }
  }
  drawMarkers();
}

// The now-marker, the hover crosshair, and each header's readout (the
// hovered time's value, else the current timestep's).
function drawMarkers() {
  if (!view.times) return;
  const now = forcingState.timeIndex;
  const at = view.hoverIndex ?? now;
  for (const p of view.panels) {
    if (!p.values) continue;
    const v = p.values[at];
    p.valueEl.textContent = Number.isFinite(v)
      ? `${fmtValue(v)}${p.meta.units ? " " + p.meta.units : ""}`
      : "–";
    if (!p.geom) continue;
    const xNow = p.geom.x(new Date(view.times[now]));
    p.g.now.attr("x1", xNow).attr("x2", xNow);
    if (view.hoverIndex == null) {
      p.g.cross.style("display", "none");
    } else {
      const xh = p.geom.x(new Date(view.times[view.hoverIndex]));
      p.g.cross.style("display", null).attr("x1", xh).attr("x2", xh);
    }
  }
  els.status.title = fmtTime(new Date(view.times[at]));
}
