// ====================================================================
// Colour-map pickers: the one <select> builder every data panel uses
// ====================================================================
import { state } from "../state.js";
import { colormapColors, colormapGroups } from "../color/colormaps.js";

// Fill `select` with every colour map, grouped, diverging first for a diff.
export function fillColormapSelect(select, isDiff, value) {
  select.replaceChildren(
    ...colormapGroups(isDiff).map(({ label, maps }) => {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const c of maps) group.append(new Option(c.label, c.id));
      return group;
    }),
  );
  select.value = value;
}

// The flowpaths run's colour-map id: diffs keep their own choice.
export function runColormapId(data = state.data) {
  return data?.isDiff ? state.diffColormap : state.colormap;
}

export function runColors(data = state.data) {
  return colormapColors(runColormapId(data), !!data?.isDiff);
}

export function setRunColormapId(id, data = state.data) {
  if (data?.isDiff) state.diffColormap = id;
  else state.colormap = id;
}
