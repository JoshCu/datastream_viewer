// ====================================================================
// Hydrofabric style merge — inlined copy of map_app/map_layers.js so this
// viewer paints the same base.json layers (flowpaths, divides, gages).
// ====================================================================
import { HIDDEN_FILTER } from "../config.js";

export function updateIncomingStyle(previousStyle, nextStyle) {
  const computedStyle = getComputedStyle(document.documentElement);
  const cssColor = (name, fallback) =>
    computedStyle.getPropertyValue(name).trim() || fallback;

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
      gages: {
        type: "vector",
        url: "pmtiles://" + s3_url + "pmtiles/gages.pmtiles",
      },

    },
    layers: [
      {
        id: "flowpaths",
        type: "line",
        source: "flowpaths",
        "source-layer": "flowpaths",
        layout: { "line-cap": "round" },
        paint: {
          "line-width": [
            "interpolate",
            ["exponential", 1.6],
            ["get", "order"],
            1,
            1,
            8,
            6,
          ],
          "line-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            1.3,
            "rgba(0, 119, 187, 0)",
            5,
            "rgba(0, 119, 187, 1)",
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
        source: "divides",
        "source-layer": "divides",
        paint: {
          "fill-color": "rgba(0, 0, 0, 0)",
          "fill-outline-color": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            "rgba(1, 1, 1, 0)",
            7,
            "rgba(1, 1, 1, 0.5)",
          ],
        },
      },
      {
        id: "selected-divides",
        type: "fill",
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
        source: "divides",
        "source-layer": "divides",
        paint: {
          "fill-color": "rgba(0, 255, 136, 0.15)",
          "fill-outline-color": "rgba(0, 255, 136, 0.6)",
        },
        filter: HIDDEN_FILTER,
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
        id: "conus_gages",
        type: "circle",
        source: "gages",
        "source-layer": "gages",
        filter: HIDDEN_FILTER,
        paint: {
          "circle-radius": {
            stops: [
              [3, 2],
              [11, 5],
            ],
          },
          "circle-color": cssColor("--color-base-content", "#c8c8c8"),
          "circle-opacity": {
            stops: [
              [3, 0],
              [9, 1],
            ],
          },
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
    ],
  };
}
