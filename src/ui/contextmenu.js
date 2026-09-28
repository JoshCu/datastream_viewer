// ====================================================================
// Map right-click menu: forcings, hydrograph and upstream highlight for
// whatever is under the cursor.
//
// A right-drag rotates/pitches the map, so the menu only opens for a right
// click that didn't move. Where the browser fires `contextmenu` on mousedown
// (Linux, macOS) the menu waits for the mouseup; where it fires after the
// mouseup (Windows) it opens straight away if the pointer stayed put. A
// touch long-press fires `contextmenu` with no mouse sequence and opens too.
// ====================================================================
import { state, map } from "../state.js";
import { catchmentAt } from "../forcing/viewport.js";
import { hasForcingSource } from "../forcing/loader.js";
import { isUpstreamHighlighted, reachAt, toggleUpstreamHighlight } from "../map/interactions.js";
import { showFeatureInfo } from "./infopanel.js";
import { openForcingPlot } from "./forcingplot.js";
// maplibregl is a global provided by the CDN <script> in index.html.

const CLICK_SLOP_PX = 4;

let menu = null;

export function setupContextMenu() {
  menu = document.createElement("div");
  menu.className = "map-context-menu";
  menu.setAttribute("role", "menu");
  document.body.appendChild(menu);

  const container = map.getCanvasContainer();
  let down = null; // client position of the right-button mousedown
  let held = false;
  let pending = null; // contextmenu seen while the button is still down

  container.addEventListener("mousedown", (e) => {
    if (e.button === 2) {
      down = { x: e.clientX, y: e.clientY };
      held = true;
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 2 || !held) return;
    held = false;
    if (pending && still(down, e)) open(pending.x, pending.y);
    pending = null;
  });
  container.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    if (held) {
      pending = at;
      return;
    }
    if (!down || still(down, e)) open(at.x, at.y);
    down = null;
  });

  // Anything else dismisses it.
  document.addEventListener("mousedown", (e) => {
    if (!menu.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  map.on("movestart", close);
  map.on("wheel", close);
}

function still(from, e) {
  return Math.hypot(e.clientX - from.x, e.clientY - from.y) <= CLICK_SLOP_PX;
}

function close() {
  menu?.classList.remove("visible");
}

function itemsAt(point, lngLat) {
  const items = [];
  const catchment = catchmentAt(point);
  const reach = state.data ? reachAt(point) : null;
  if (catchment) {
    const id = catchment.id;
    items.push(
      hasForcingSource()
        ? { label: `Forcings for cat-${id}`, action: () => openForcingPlot(id, point) }
        : { label: `Forcings for cat-${id}`, hint: "Pick a forcing cycle first", disabled: true },
    );
  }
  if (reach) {
    items.push({ label: `Hydrograph for wb-${reach.id}`, action: () => showFeatureInfo(reach) });
  }
  if (catchment) {
    items.push({
      label: isUpstreamHighlighted(catchment)
        ? "Clear upstream highlight"
        : `Highlight upstream of cat-${catchment.id}`,
      action: () => toggleUpstreamHighlight(catchment, lngLat),
    });
  }
  return items;
}

function open(clientX, clientY) {
  const rect = map.getCanvas().getBoundingClientRect();
  const point = new maplibregl.Point(clientX - rect.left, clientY - rect.top);
  const items = itemsAt(point, map.unproject(point));
  if (!items.length) {
    close();
    return;
  }

  menu.replaceChildren(
    ...items.map(({ label, hint, disabled, action }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "map-context-item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = label;
      if (hint) {
        const sub = document.createElement("span");
        sub.className = "map-context-hint";
        sub.textContent = hint;
        btn.appendChild(sub);
      }
      btn.disabled = !!disabled;
      btn.addEventListener("click", () => {
        close();
        action?.();
      });
      return btn;
    }),
  );

  // Place it at the cursor, flipped to stay on screen.
  menu.classList.add("visible");
  const { offsetWidth: w, offsetHeight: h } = menu;
  const x = clientX + w > window.innerWidth - 4 ? clientX - w : clientX;
  const y = clientY + h > window.innerHeight - 4 ? clientY - h : clientY;
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
}
