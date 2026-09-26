// ====================================================================
// Small shared DOM builders.
//
// Leaf module: imports nothing, so any panel can use it.
// ====================================================================

// A "<label> <value>" row, as used by the reach info panel, the gage panel and
// the map tooltips. `prefix` picks the class family ("info" or "tooltip");
// `cls` is an optional extra class on the value (status colouring).
//
// Built with textContent rather than an HTML string on purpose: several callers
// feed this straight from vector-tile properties and USGS responses, so
// escaping has to be structural rather than remembered at each call site.
export function labeledRow(label, value, { prefix = "info", cls } = {}) {
  const row = document.createElement("div");
  row.className = `${prefix}-row`;
  const labelEl = document.createElement("span");
  labelEl.className = `${prefix}-label`;
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = cls ? `${prefix}-value ${cls}` : `${prefix}-value`;
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

// The same, for a list of [label, value, cls] triples.
export function labeledRows(pairs, options) {
  const frag = document.createDocumentFragment();
  for (const [label, value, cls] of pairs) {
    frag.append(labeledRow(label, value, { ...options, cls }));
  }
  return frag;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A MapLibre control button carrying one SVG path. Shared by the gage and
// hillshade controls so they stay visually consistent; `pathStyle` is for the
// stroke-drawn icons, whose look can't be expressed by the path alone.
export function iconButton(className, title, pathD, { pathStyle } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathD);
  if (pathStyle) path.setAttribute("style", pathStyle);
  svg.appendChild(path);
  const icon = document.createElement("span");
  icon.className = "maplibregl-ctrl-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.appendChild(svg);
  button.appendChild(icon);
  return button;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A USGS period-of-record date. Still-reporting gages are the common case, and
// an exact end date for those is noise.
export function fmtDay(ms) {
  if (ms == null) return "?";
  if (Date.now() - ms < 3 * DAY_MS) return "present";
  return new Date(ms).toISOString().slice(0, 10);
}

// Escape a string for the few places that still build markup as HTML.
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
