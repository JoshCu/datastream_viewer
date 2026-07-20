// ====================================================================
// Entry point. Everything lives in focused modules under src/; this file
// just kicks off the app once the DOM is ready.
//
// Module map:
//   config.js            shared constants
//   state.js             mutable singletons (state, s3State, map)
//   map/                  basemap style, init/bootstrap, results paint, interactions
//   color/                scales, class breaks, MapLibre paint expressions
//   s3/                   listing client (client.js) + browser UI (browser.js)
//   data/                 load orchestration + parse/merge worker
//   ui/                   playback, panels, time readout, overview, info panel
// ====================================================================
import { init } from "./map/init.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
