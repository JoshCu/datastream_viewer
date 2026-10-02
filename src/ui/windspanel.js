// ====================================================================
// Winds aloft panel: Open-Meteo's hourly pressure-level winds for one point
// over one UTC day, drawn as a time–height grid of arrows (pointing where the
// air goes, coloured by speed). Hover a cell for its values; click a column
// for that hour's table. The point is the map centre, or wherever "Winds
// aloft here" was picked in the right-click menu (ui/contextmenu.js).
// ====================================================================
import { map } from "../state.js";
import { setStatus } from "./panels.js";
import { fetchWinds, EARLIEST_DATE } from "../winds/openmeteo.js";
import { compass } from "../nexrad/birds.js";
// maplibregl is a global provided by the CDN <script> in index.html.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const status = (kind, text) => setStatus(kind, text, "winds");
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms).getUTCHours();

// Speed colour ramp (sequential, one hue: dim → bright on the dark panel).
const MAX_SPEED = 40; // m/s, the top of the ramp
const RAMP = [
  [0, [38, 64, 82]],
  [10, [0, 140, 190]],
  [25, [0, 212, 255]],
  [40, [220, 248, 255]],
];

function speedColor(s) {
  const v = Math.min(MAX_SPEED, Math.max(0, s));
  for (let i = 1; i < RAMP.length; i++) {
    const [v1, c1] = RAMP[i];
    if (v > v1) continue;
    const [v0, c0] = RAMP[i - 1];
    const t = (v - v0) / (v1 - v0);
    return `rgb(${c0.map((x, k) => Math.round(x + (c1[k] - x) * t)).join(",")})`;
  }
  return `rgb(${RAMP[RAMP.length - 1][1].join(",")})`;
}

let point = null; // { lat, lon }
let profile = null; // fetchWinds() result for the picked day
let hour = 0; // the selected column
let seq = 0;
let marker = null;

const meanKm = (level) => {
  const zs = level.height.filter((z) => z != null);
  return zs.reduce((a, b) => a + b, 0) / zs.length / 1000;
};

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function describe(level, i) {
  const s = level.speed[i];
  if (s == null) return `${level.hPa} hPa: no data`;
  const t = level.temp[i];
  return (
    `${String(hourOf(profile.times[i])).padStart(2, "0")}Z · ${level.hPa} hPa ` +
    `(${(level.height[i] / 1000).toFixed(2)} km): ${s.toFixed(1)} m/s from ` +
    `${compass(level.from[i])} ${level.from[i].toFixed(0)}°` +
    (t == null ? "" : ` · ${t.toFixed(1)} °C`)
  );
}

// The time–height grid: one column per hour, one row per level (lowest at
// the bottom, evenly spaced, labelled with pressure and mean height).
function drawChart() {
  const svg = $("windsChart");
  const { levels, times } = profile;
  const left = 64;
  const top = 4;
  const cell = 16;
  const width = svg.clientWidth || 320;
  const colW = (width - left - 4) / times.length;
  const height = top + levels.length * cell + 18;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", height);
  svg.replaceChildren();

  const sel = el("rect", {
    x: left + hour * colW,
    y: top,
    width: colW,
    height: levels.length * cell,
    class: "winds-selected",
  });
  svg.append(sel);

  levels.forEach((level, r) => {
    const cy = top + (levels.length - 1 - r) * cell + cell / 2;
    svg.append(
      el("text", { x: left - 6, y: cy + 3, class: "winds-axis", "text-anchor": "end" },
        `${level.hPa} · ${meanKm(level).toFixed(1)}km`),
    );
    times.forEach((_, i) => {
      const s = level.speed[i];
      if (s == null) return;
      const cx = left + (i + 0.5) * colW;
      const len = Math.min(colW, cell) * 0.42;
      // Arrow drawn pointing north, rotated to where the air goes.
      const g = el("g", {
        transform: `translate(${cx} ${cy}) rotate(${(level.from[i] + 180) % 360})`,
        stroke: speedColor(s),
        class: "winds-arrow",
      });
      g.append(
        el("path", { d: `M0 ${len} V${-len} M${-len * 0.55} ${-len * 0.35} L0 ${-len} L${len * 0.55} ${-len * 0.35}` }),
      );
      svg.append(g);
    });
  });

  times.forEach((t, i) => {
    const h = hourOf(t);
    if (h % 6) return;
    svg.append(
      el("text", { x: left + (i + 0.5) * colW, y: height - 4, class: "winds-axis", "text-anchor": "middle" },
        `${String(h).padStart(2, "0")}Z`),
    );
  });

  // One invisible hit layer: hover reads out a cell, click picks the hour.
  const hit = el("rect", { x: left, y: top, width: width - left - 4, height: levels.length * cell, fill: "transparent" });
  const cellAt = (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * width - left;
    const y = ((e.clientY - box.top) / box.height) * height - top;
    const i = Math.min(times.length - 1, Math.max(0, Math.floor(x / colW)));
    const r = levels.length - 1 - Math.min(levels.length - 1, Math.max(0, Math.floor(y / cell)));
    return { i, level: levels[r] };
  };
  hit.addEventListener("mousemove", (e) => {
    const { i, level } = cellAt(e);
    $("windsReadout").textContent = describe(level, i);
  });
  hit.addEventListener("mouseleave", () => {
    $("windsReadout").textContent = "Hover for values · click for an hour's table";
  });
  hit.addEventListener("click", (e) => {
    hour = cellAt(e).i;
    sel.setAttribute("x", left + hour * colW);
    drawTable();
  });
  svg.append(hit);
}

// The selected hour, every level (the chart's table view).
function drawTable() {
  const table = $("windsTable");
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const h of ["hPa", "km MSL", "m/s", "from", "°C"]) head.append(Object.assign(document.createElement("th"), { textContent: h }));
  const body = table.createTBody();
  for (const level of [...profile.levels].reverse()) {
    const row = body.insertRow();
    const s = level.speed[hour];
    const cells = [
      level.hPa,
      level.height[hour] == null ? "–" : (level.height[hour] / 1000).toFixed(2),
      s == null ? "–" : s.toFixed(1),
      level.from[hour] == null ? "–" : `${compass(level.from[hour])} ${level.from[hour].toFixed(0)}°`,
      level.temp[hour] == null ? "–" : level.temp[hour].toFixed(1),
    ];
    for (const c of cells) row.insertCell().textContent = c;
  }
  $("windsHour").textContent = `${isoDate(profile.times[hour])} ${String(hourOf(profile.times[hour])).padStart(2, "0")}Z`;
}

function showMarker() {
  const open = !$("windsPanel").classList.contains("collapsed");
  if (!point || !open) {
    marker?.remove();
    return;
  }
  marker ??= new maplibregl.Marker({ color: "#00d4ff", scale: 0.6 });
  marker.setLngLat([point.lon, point.lat]).addTo(map);
}

async function load() {
  const date = $("windsDate").value;
  if (!point || !date) return;
  const mine = ++seq;
  $("windsPoint").textContent = `${point.lat.toFixed(2)}°, ${point.lon.toFixed(2)}°`;
  showMarker();
  status("loading", "Fetching from Open-Meteo…");
  try {
    const result = await fetchWinds(point.lat, point.lon, date);
    if (mine !== seq) return;
    profile = result;
    hour = Math.min(hour, profile.times.length - 1);
    $("windsResult").style.display = "";
    drawChart();
    drawTable();
    status("success", `${profile.levels.length} levels · ground ${Math.round(profile.elevation)} m`);
  } catch (err) {
    if (mine === seq) status("error", err.message);
  }
}

// Point the panel at (lat, lon), open it, and load the picked day. `time`
// (epoch ms), if given, sets the day and selects that hour.
export function showWindsAt(lat, lon, time) {
  point = { lat, lon };
  if (time != null) {
    $("windsDate").value = isoDate(time);
    hour = hourOf(time);
  }
  const panel = $("windsPanel");
  if (panel.classList.contains("collapsed")) panel.querySelector(".panel-title").click();
  load();
}

export function setupWindsPanel() {
  const today = isoDate(Date.now());
  $("windsDate").value = today;
  $("windsDate").min = EARLIEST_DATE;
  $("windsDate").max = isoDate(Date.now() + 7 * 86400000); // the forecast runs a week ahead
  $("windsDate").addEventListener("change", load);
  $("windsCentreBtn").addEventListener("click", () => {
    const c = map.getCenter();
    showWindsAt(c.lat, c.lng);
  });
  $("windsPanel").querySelector(".panel-title").addEventListener("click", showMarker);
  new ResizeObserver(() => profile && drawChart()).observe($("windsChart"));
  $("windsLegendGradient").style.background =
    `linear-gradient(to right, ${RAMP.map(([v, c]) => `rgb(${c.join(",")}) ${(v / MAX_SPEED) * 100}%`).join(", ")})`;
}
