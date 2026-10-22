// ====================================================================
// Colour maps shared by every data layer (runs, diffs, forcings)
// ====================================================================
// Pure data, imports nothing. Sequential maps come first, then diverging;
// the pickers keep that order for ordinary data and put the diverging
// group first for a diff, so every map stays available to both.
//
// Stops run low → high. The map sits on a dark basemap, so sequential maps
// run dark → bright, and the darkest near-black stops of magma / inferno are
// dropped so the lowest values don't vanish into it. Diverging maps are odd
// length with their neutral stop in the middle (zero difference) and put the
// cool / dry colour on the negative side (A below B).

export const COLORMAPS = [
  // ---- Sequential (positive-only data) ----
  {
    id: "icefire",
    label: "Ice → fire",
    kind: "sequential",
    colors: ["#0077b6", "#00b4d8", "#90e0ef", "#ffba08", "#ff6b35", "#d00000"],
  },
  {
    id: "viridis",
    label: "Viridis",
    kind: "sequential",
    colors: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
  },
  {
    id: "plasma",
    label: "Plasma",
    kind: "sequential",
    colors: ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"],
  },
  {
    id: "magma",
    label: "Magma",
    kind: "sequential",
    colors: ["#1c1044", "#4f127b", "#812581", "#b5367a", "#e55964", "#fb8761", "#fec287", "#fcfdbf"],
  },
  {
    id: "inferno",
    label: "Inferno",
    kind: "sequential",
    colors: ["#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"],
  },
  {
    id: "cividis",
    label: "Cividis (colour-blind safe)",
    kind: "sequential",
    colors: ["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8678", "#a59c74", "#c3b369", "#e1cc55", "#fee838"],
  },
  {
    id: "turbo",
    label: "Turbo (rainbow)",
    kind: "sequential",
    colors: ["#30123b", "#4662d7", "#36aaf9", "#1ae4b6", "#72fe5e", "#c8ef34", "#faba39", "#f66b19", "#ca2a04", "#7a0403"],
  },
  {
    id: "blues",
    label: "Blues",
    kind: "sequential",
    colors: ["#08519c", "#2171b5", "#4292c6", "#6baed6", "#9ecae1", "#c6dbef", "#eff3ff"],
  },
  {
    id: "ylgnbu",
    label: "Blue → green → yellow",
    kind: "sequential",
    colors: ["#253494", "#225ea8", "#1d91c0", "#41b6c4", "#7fcdbb", "#c7e9b4", "#edf8b1", "#ffffd9"],
  },
  {
    id: "heat",
    label: "Heat",
    kind: "sequential",
    colors: ["#800026", "#bd0026", "#e31a1c", "#fc4e2a", "#fd8d3c", "#feb24c", "#fed976", "#ffffcc"],
  },

  // ---- Diverging (signed data, centred on zero) ----
  {
    id: "rdbu",
    label: "Blue ↔ red",
    kind: "diverging",
    colors: ["#2166ac", "#67a9cf", "#d1e5f0", "#f7f7f7", "#fddbc7", "#ef8a62", "#b2182b"],
  },
  {
    id: "icefire-dark",
    label: "Ice ↔ fire (dark centre)",
    kind: "diverging",
    colors: ["#9fe2ff", "#3fa9e0", "#2a6bb0", "#1f3666", "#1c1c22", "#66202c", "#b32d2a", "#e8622c", "#ffb366"],
  },
  {
    id: "rdylbu",
    label: "Blue ↔ yellow ↔ red",
    kind: "diverging",
    colors: ["#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#ffffbf", "#fee090", "#fdae61", "#f46d43", "#d73027"],
  },
  {
    id: "spectral",
    label: "Spectral",
    kind: "diverging",
    colors: ["#3288bd", "#66c2a5", "#abdda4", "#e6f598", "#ffffbf", "#fee08b", "#fdae61", "#f46d43", "#d53e4f"],
  },
  {
    id: "brbg",
    label: "Brown ↔ teal",
    kind: "diverging",
    colors: ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e"],
  },
  {
    id: "prgn",
    label: "Purple ↔ green",
    kind: "diverging",
    colors: ["#762a83", "#9970ab", "#c2a5cf", "#e7d4e8", "#f7f7f7", "#d9f0d3", "#a6dba0", "#5aae61", "#1b7837"],
  },
  {
    id: "piyg",
    label: "Pink ↔ green",
    kind: "diverging",
    colors: ["#c51b7d", "#de77ae", "#f1b6da", "#fde0ef", "#f7f7f7", "#e6f5d0", "#b8e186", "#7fbc41", "#4d9221"],
  },
];

export const DEFAULT_COLORMAP = "icefire";
export const DEFAULT_DIFF_COLORMAP = "rdbu";

const BY_ID = new Map(COLORMAPS.map((c) => [c.id, c]));

// Stops of colour map `id`, falling back to the default for the data kind.
export function colormapColors(id, isDiff = false) {
  return (
    BY_ID.get(id) ?? BY_ID.get(isDiff ? DEFAULT_DIFF_COLORMAP : DEFAULT_COLORMAP)
  ).colors;
}

// Picker order: as listed, or diverging first for a diff.
export function colormapGroups(isDiff) {
  const groups = [
    { label: "Sequential", maps: COLORMAPS.filter((c) => c.kind === "sequential") },
    { label: "Diverging", maps: COLORMAPS.filter((c) => c.kind === "diverging") },
  ];
  return isDiff ? groups.reverse() : groups;
}

// CSS gradient for a legend bar.
export function colormapGradient(colors) {
  return `linear-gradient(to right, ${colors.join(", ")})`;
}
