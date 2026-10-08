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
  USGS_SITES_SOURCE,
  USGS_SITES_LAYER,
  USGS_SITES_LABEL_LAYER,
  FORCING_FILL_OPACITY,
  NO_DATA_COLOR,
} from "../config.js";

export function updateIncomingStyle(previousStyle, nextStyle) {
  const s3_url = "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/";
  const upstream_index_url = s3_url + "only_geometry/upstream_index/";

  const hydrofabric_map_data = {
    sources: {
      flowpaths: {
        type: "vector",
        url: "pmtiles://" + upstream_index_url + "flowpaths.pmtiles",
      },
      divides: {
        type: "vector",
        url: "pmtiles://" + upstream_index_url + "divides.pmtiles",
      },
      terrainSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
      },
      hillshadeSource: {
        type: "raster-dem",
        url: "https://tiles.mapterhorn.com/tilejson.json",
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
      // Every USGS site with a continuous record (map/usgssites.js); empty
      // until the catalog loads. promoteId so hover feature-state can target
      // one site by its monitoring-location id.
      [USGS_SITES_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      },
      // Where the searched-for gage is (map/search.js); empty until then.
      [SEARCH_POINT_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },

    },
    layers: [
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
          "line-color": "rgb(0, 119, 187)",
      
          // Fade orders in progressively instead of popping
          "line-opacity": [
            "interpolate", ["linear"], ["zoom"],
            1.3, 0,
            3,   ["step", ["get", "order"], 0, 6, 1],   // order 6+
            5,   ["step", ["get", "order"], 0, 4, 1],   // order 4+ (3 starts fading in)
            6,   ["step", ["get", "order"], 0, 3, 1],   // order 3+; order 2 held at 0 as it appears
            7,   ["step", ["get", "order"], 0, 2, 1],   // order 2 faded in; order 1 held at 0 as it appears
            8,   1,                                      // order 1 faded in
          ],
      
          "line-width": [
            "interpolate", ["exponential", 2], ["zoom"],
            // low zoom: purely cartographic, by order
            4, ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 0.3, 8, 3],
            8, ["max",
                 ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 0.6, 8, 5],
                 ["*", ["coalesce", ["get", "widthcm"], 0], 0.0000327]],
            12, ["max",
                 ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 1, 8, 7],
                 ["*", ["coalesce", ["get", "widthcm"], 0], 0.000523]],
            // high zoom: true ground width, with a 1px floor
            16, ["max", 1, ["*", ["coalesce", ["get", "widthcm"], 0], 0.00837]],
            22, ["max", 1, ["*", ["coalesce", ["get", "widthcm"], 0], 0.536]],
          ],
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
        type: "circle",
        source: "gages",
        "source-layer": "gages",
        // Hidden until a run loads; map/gages.js then filters to the gages
        // on that run's reaches, so the layer is sparse enough to draw at
        // every zoom rather than fading in only when zoomed close. Drawn over
        // the catalog dots (usgs-sites), white so the run's gages stand out.
        filter: HIDDEN_FILTER,
        paint: {
          "circle-radius": {
            stops: [
              [3, 3],
              [11, 6],
            ],
          },
          "circle-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            "#00d4ff",
            "#ffffff",
          ],
          "circle-stroke-color": "#1a1a2e",
          "circle-stroke-width": 1.5,
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
