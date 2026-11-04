// ====================================================================
// Hydrofabric style merge — inlined copy of map_app/map_layers.js so this
// viewer paints the same base.json layers (flowpaths, divides, gages).
// ====================================================================
import {
  HIDDEN_FILTER,
  FORCING_LAYER,
  VPU_LAYER,
  SEARCH_LAYER,
  SEARCH_POINT_SOURCE,
  SEARCH_POINT_LAYER,
  HOVER_CELL_SOURCE,
  HOVER_CELL_LAYER,
  HOVER_DIVIDE_LAYER,
  HOVER_DIVIDE_STATE,
  USGS_SITES_SOURCE,
  USGS_SITES_LAYER,
  USGS_SITES_LABEL_LAYER,
  USGS_DENSITY_SOURCE,
  USGS_DENSITY_LAYER,
  HUC_SOURCE,
  HUC_LEVELS,
  hucLineLayer,
  hucFillLayer,
  hucSearchLayer,
  FORCING_FILL_OPACITY,
  NO_DATA_COLOR,
  FLOOD_LAYER,
  GAGE_ICON,
} from "../config.js";
import { BASE_FLOWPATH_PAINT, BASE_NWM_PAINT, withHover } from "./flowpathstyle.js";

// Fade orders in progressively instead of popping. Both networks thin by
// order at low zoom on roughly the same schedule.
const ORDER_FADE_OPACITY = [
  "interpolate", ["linear"], ["zoom"],
  1.3, 0,
  3,   ["step", ["get", "order"], 0, 6, 1],   // order 6+
  5,   ["step", ["get", "order"], 0, 4, 1],   // order 4+ (3 starts fading in)
  6,   ["step", ["get", "order"], 0, 3, 1],   // order 3+; order 2 held at 0 as it appears
  7,   ["step", ["get", "order"], 0, 2, 1],   // order 2 faded in; order 1 held at 0 as it appears
  8,   1,                                      // order 1 faded in
];

// One HUC level's boundary, plus an invisible fill so the hover tooltip can
// find the unit under the cursor. Hidden until map/huc.js shows them, and with
// them hidden the source fetches no tiles.
function hucLayers({ key, minzoom, color, width }) {
  const common = { source: HUC_SOURCE, "source-layer": key, minzoom };
  return [
    {
      ...common,
      id: hucFillLayer(key),
      type: "fill",
      layout: { visibility: "none" },
      paint: { "fill-color": "#000000", "fill-opacity": 0 },
    },
    {
      ...common,
      id: hucLineLayer(key),
      type: "line",
      layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": width, "line-opacity": 0.85 },
    },
  ];
}

export function updateIncomingStyle(previousStyle, nextStyle) {
  const s3_url = "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/";
  const upstream_index_url = s3_url + "only_geometry/upstream_index/";

  const hydrofabric_map_data = {
    sources: {
      flowpaths: {
        type: "vector",
        url: "pmtiles://" + upstream_index_url + "flowpaths.pmtiles",
      },
      // NWM v3 channel network (RouteLink v3.1.6): COMID feature ids, MLT
      // tiles. z0–6 carry only the id and order; the RouteLink attributes
      // start at z7. Reaches shorter than one tile unit are missing below
      // z12. See report.md's flowline PMTiles appendix.
      "nwm-flowlines": {
        type: "vector",
        url: "pmtiles://" + s3_url + "pmtiles/nwm/flowpaths_attrs.pmtiles",
        encoding: "mlt",
      },
      divides: {
        type: "vector",
        url: "pmtiles://" + upstream_index_url + "divides.pmtiles",
      },
      terrainSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
        maxzoom: 17,
      },
      hillshadeSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
        maxzoom: 17,
      },
      // VPU polygons (vpuid "01".."18"): which forcing file covers the view.
      vpus: {
        type: "vector",
        url: "pmtiles://" + s3_url + "vpu.pmtiles",
      },
      gages: {
        type: "vector",
        url: "pmtiles://" + s3_url + "pmtiles/gages.pmtiles",
        // Gage points carry no feature id in the tiles; promote hl_uri
        // ("gages-<site>") so hover feature-state can target one gage.
        promoteId: "hl_uri",
      },
      // Hydrologic unit polygons, one source-layer per level (map/huc.js).
      [HUC_SOURCE]: {
        type: "vector",
        url: "pmtiles://" + s3_url + "pmtiles/huc.pmtiles",
      },
      // Every USGS site with a continuous record (map/usgssites.js); empty
      // until the catalog loads. promoteId so hover feature-state can target
      // one site by its monitoring-location id.
      [USGS_SITES_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      },
      // The same sites for the density heatmap (map/usgsdensity.js), empty
      // until it's on. Its own source for the low maxzoom: a heatmap only
      // draws the points of tiles in view, so at this source's z3 a kernel
      // only goes missing near a z3 tile's edge.
      [USGS_DENSITY_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        maxzoom: 3,
      },
      // Where the searched-for gage is (map/search.js); empty until then.
      [SEARCH_POINT_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
      [HOVER_CELL_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },

    },
    layers: [
      {
        // Flood water (ui/floodpanel.js): the DEM tinted below the water
        // level, under everything else of ours so rivers and gages stay on
        // top. Shares the hillshade's DEM source; its colour ramp is set by
        // the panel, and it's hidden until the panel opens.
        id: FLOOD_LAYER,
        type: "color-relief",
        source: "hillshadeSource",
        layout: { visibility: "none" },
        paint: {
          "color-relief-color": [
            "interpolate", ["linear"], ["elevation"],
            0, "rgba(0, 0, 0, 0)",
            1, "rgba(0, 0, 0, 0)",
          ],
        },
      },
      {
        // Forcing colours on the catchments (src/forcing/paint.js), under the
        // rivers. Always rendered — transparent until forcings load — so
        // catchment clicks and viewport queries work with the outlines off.
        id: FORCING_LAYER,
        type: "fill",
        source: "divides",
        "source-layer": "divides",
        paint: {
          "fill-color": NO_DATA_COLOR,
          "fill-opacity": FORCING_FILL_OPACITY,
          "fill-antialias": false,
        },
      },
      {
        // Invisible, but queryable: which VPUs the view covers.
        id: VPU_LAYER,
        type: "fill",
        source: "vpus",
        "source-layer": "vpu",
        paint: { "fill-color": "#000000", "fill-opacity": 0 },
      },
      {
        // Gage density (map/usgsdensity.js), under the rivers so the network
        // reads through it. Paint and filter are set from the panel.
        id: USGS_DENSITY_LAYER,
        type: "heatmap",
        source: USGS_DENSITY_SOURCE,
        maxzoom: 12,
        filter: HIDDEN_FILTER,
        layout: { visibility: "none" },
      },
      // HUC boundaries, under the rivers, with the coarsest on top where
      // levels share a line.
      ...HUC_LEVELS.toReversed().flatMap(hucLayers),
      {
        id: "flowpaths",
        type: "line",
        source: "flowpaths",
        "source-layer": "flowpaths",
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // draw big rivers on top of small tributaries
          "line-sort-key": ["get", "order"],
        },
        paint: {
          "line-color": withHover("line-color", BASE_FLOWPATH_PAINT["line-color"]),

          "line-opacity": ORDER_FADE_OPACITY,

          // Hovered reach drawn inverted and wider: see map/flowpathstyle.js.
          "line-width": withHover("line-width", BASE_FLOWPATH_PAINT["line-width"]),
        },
      },
      {
        // Invisible fat overlay so hovering thin lines is forgiving.
        id: "flowpaths-hover",
        type: "line",
        source: "flowpaths",
        "source-layer": "flowpaths",
        layout: { "line-cap": "round" },
        paint: { "line-width": 14, "line-color": "#000000", "line-opacity": 0 },
      },
      {
        // NWM flowlines: hidden until toggled on (map/interactions.js).
        id: "nwm-flowlines",
        type: "line",
        source: "nwm-flowlines",
        "source-layer": "flowpaths",
        layout: {
          visibility: "none",
          "line-cap": "round",
          "line-join": "round",
          "line-sort-key": ["get", "order"],
        },
        paint: {
          "line-color": withHover("line-color", BASE_NWM_PAINT["line-color"]),
          "line-opacity": ORDER_FADE_OPACITY,
          "line-width": withHover("line-width", BASE_NWM_PAINT["line-width"]),
        },
      },
      {
        id: "nwm-flowlines-hover",
        type: "line",
        source: "nwm-flowlines",
        "source-layer": "flowpaths",
        layout: { visibility: "none", "line-cap": "round" },
        paint: { "line-width": 14, "line-color": "#000000", "line-opacity": 0 },
      },
      {
        id: "divides",
        type: "fill",
        layout: { visibility: "none" },
        source: "divides",
        "source-layer": "divides",
        paint: {
          "fill-color": "rgba(0, 0, 0, 0)",
          "fill-outline-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            7,
            "rgba(1, 1, 1, 0)",
            14,
            "rgba(1, 1, 1, 0.5)",
          ],
        },
      },
      {
        id: "selected-divides",
        type: "fill",
        layout: { visibility: "none" },
        source: "divides",
        "source-layer": "divides",
        paint: {
          "fill-color": "rgba(0, 212, 255, 0.316)",
          "fill-outline-color": "rgba(0, 212, 255, 0.7)",
        },
        filter: HIDDEN_FILTER,
      },
      {
        id: "upstream-divides",
        type: "fill",
        layout: { visibility: "none" },
        source: "divides",
        "source-layer": "divides",
        paint: {
          "fill-color": "rgba(0, 255, 136, 0.15)",
          "fill-outline-color": "rgba(0, 255, 136, 0.6)",
        },
        filter: HIDDEN_FILTER,
      },
      {
        // Outline of the catchment shown in the forcing plot.
        id: "forcing-selected",
        type: "line",
        source: "divides",
        "source-layer": "divides",
        filter: HIDDEN_FILTER,
        paint: { "line-color": "#00d4ff", "line-width": 2.5 },
      },
      {
        // The catchment found by the search box (map/search.js).
        id: SEARCH_LAYER,
        type: "line",
        source: "divides",
        "source-layer": "divides",
        filter: HIDDEN_FILTER,
        paint: { "line-color": "#ffaa00", "line-width": 3, "line-dasharray": [2, 1] },
      },
      // The hydrologic unit found by the search box, one layer per level's
      // source-layer. Hidden until used, so the search fetches no HUC tiles
      // before someone picks a unit (map/huc.js).
      ...HUC_LEVELS.map(({ key, minzoom }) => ({
        id: hucSearchLayer(key),
        type: "line",
        source: HUC_SOURCE,
        "source-layer": key,
        minzoom,
        filter: HIDDEN_FILTER,
        layout: { visibility: "none" },
        paint: { "line-color": "#ffaa00", "line-width": 3, "line-dasharray": [2, 1] },
      })),
      {
        // Hidden until the first hover needs it, so a session that never
        // uses it doesn't lay out a line for every catchment.
        id: HOVER_DIVIDE_LAYER,
        type: "line",
        source: "divides",
        "source-layer": "divides",
        layout: { visibility: "none" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 2,
          "line-opacity": ["case", ["boolean", ["feature-state", HOVER_DIVIDE_STATE], false], 1, 0],
        },
      },
      {
        id: HOVER_CELL_LAYER,
        type: "line",
        source: HOVER_CELL_SOURCE,
        paint: { "line-color": "#ffffff", "line-width": 2 },
      },
      {
        id: "hills",
        type: "hillshade",
        source: "hillshadeSource",
        layout: { visibility: "none" },

        paint: {
          // "hillshade-shadow-color": "#473B24",
          "hillshade-highlight-color": "#555555",
          "hillshade-method": "standard",
          "hillshade-illumination-direction": 315,
          "hillshade-shadow-color": "#000000",
          // 'hillshade-highlight-color': '#FFFFFF',
          "hillshade-accent-color": "#000000",
          "hillshade-exaggeration": 0.5,
          resampling: "nearest",
        },
      },
      {
        // USGS catalog sites, coloured by observation type. Filter and colour
        // are set by map/usgssites.js from the panel's type toggles.
        id: USGS_SITES_LAYER,
        type: "circle",
        source: USGS_SITES_SOURCE,
        filter: HIDDEN_FILTER,
        paint: {
          "circle-radius": {
            stops: [
              [3, 2.5],
              [8, 4],
              [12, 6],
            ],
          },
          "circle-color": "#888888",
          "circle-stroke-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            "#00d4ff",
            "#ffffff",
          ],
          "circle-stroke-width": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            3,
            0.75,
          ],
        },
      },
      {
        // Soft halo drawn beneath the hovered gage dot; invisible otherwise.
        id: "conus_gages_glow",
        type: "circle",
        source: "gages",
        "source-layer": "gages",
        filter: HIDDEN_FILTER,
        paint: {
          "circle-radius": {
            stops: [
              [3, 9],
              [11, 16],
            ],
          },
          "circle-color": "#00d4ff",
          "circle-blur": 0.8,
          "circle-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            0.9,
            0,
          ],
        },
      },
      {
        id: "conus_gages",
        type: "symbol",
        source: "gages",
        "source-layer": "gages",
        // Hidden until a run loads; map/gages.js then filters to the gages
        // on that run's reaches, so the layer is sparse enough to draw at
        // every zoom rather than fading in only when zoomed close. Drawn over
        // the catalog dots (usgs-sites) as dark-ringed triangles so the run's
        // gages stand out; once the catalog loads, map/gages.js filters and
        // colours them like those dots (white until then).
        filter: HIDDEN_FILTER,
        layout: {
          "icon-image": GAGE_ICON,
          "icon-size": {
            stops: [
              [3, 0.6],
              [11, 1],
            ],
          },
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            "#00d4ff",
            "#ffffff",
          ],
          "icon-halo-color": "#1a1a2e",
          "icon-halo-width": 3,
        },
      },
    ],
    // Drawn above the basemap's own labels (see the return below) so place
    // names don't win symbol collisions against gage ids.
    overlayLayers: [
      {
        // Site number beside each catalog dot, close in. Toggled with the
        // run's gage labels (map/gages.js); filtered with the dots.
        id: USGS_SITES_LABEL_LAYER,
        type: "symbol",
        source: USGS_SITES_SOURCE,
        minzoom: 8,
        filter: HIDDEN_FILTER,
        layout: {
          visibility: "none",
          "text-field": ["get", "no"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 0.8,
          "text-justify": "auto",
        },
        paint: {
          "text-color": "#1a1a2e",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      },
      {
        // USGS site number beside each gage dot. Off until toggled on from
        // the gage control; filtered alongside the dots by map/gages.js.
        id: "conus_gages_label",
        type: "symbol",
        source: "gages",
        "source-layer": "gages",
        filter: HIDDEN_FILTER,
        layout: {
          visibility: "none",
          // hl_uri is "gages-<site>"; drop the 6-char prefix.
          "text-field": ["slice", ["get", "hl_uri"], 6],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 0.8,
          "text-justify": "auto",
        },
        paint: {
          "text-color": "#1a1a2e",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      },
      {
        // Ring around the gage found by the search box (map/search.js).
        id: SEARCH_POINT_LAYER,
        type: "circle",
        source: SEARCH_POINT_SOURCE,
        paint: {
          "circle-radius": 11,
          "circle-color": "rgba(0, 0, 0, 0)",
          "circle-stroke-color": "#ffaa00",
          "circle-stroke-width": 3,
        },
      },
    ],
    terrain: {
      source: "terrainSource",
      exaggeration: 1,
    },
  };

  const boostTextHalo = (layer) => ({
    ...layer,
    paint: { ...layer.paint, "text-halo-width": 3, "text-halo-blur": 3 },
  });

  return {
    ...nextStyle,
    sources: { ...nextStyle.sources, ...hydrofabric_map_data.sources },
    layers: [
      ...nextStyle.layers.filter((layer) => layer.type !== "symbol"),
      ...hydrofabric_map_data.layers,
      ...nextStyle.layers.filter(
        (layer) =>
          layer.type === "symbol" &&
          !layer.paint?.["text-halo-width"] &&
          !layer.layout?.["icon-image"],
      ),
      ...nextStyle.layers
        .filter(
          (layer) =>
            layer.type === "symbol" && layer.paint?.["text-halo-width"],
        )
        .map(boostTextHalo),
      ...hydrofabric_map_data.overlayLayers,
    ],
  };
}
