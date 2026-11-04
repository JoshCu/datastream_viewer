#!/usr/bin/env bash
# Builds the standalone dist/datastream_viewer.html plus its sidecar workers.
#
# Bun's HTML bundler doesn't understand `new Worker(new URL(...))` — it leaves
# that call untouched rather than splitting/rewriting it (true for --compile
# single-file output and for plain --outdir output alike). So each worker has
# to be built as its own entrypoint and placed where the URL in its call site
# points. The inline module script that --compile produces resolves
# import.meta.url to the HTML document's own URL, so these sidecar paths are
# resolved relative to wherever the html file is served from.
#
# The live-routing wasm (src/vendor/mc_route) is the same story: the glue's
# `new URL("mc_route_bg.wasm", import.meta.url)` is left as-is, so it resolves
# next to the html file and the binary is copied there. That glue is built by
# ./build-wasm.sh and committed; this script doesn't rebuild it.
set -euo pipefail
cd "$(dirname "$0")"

# Pinned: older buns (1.3.5 and before) accept --compile --target=browser, print
# "No output files to bundle" and exit 0. The first run downloads it into bun's cache.
BUN=(bunx bun@1.4.4)

rm -rf dist/datastream_viewer.html dist/workers dist/flow.worker.js dist/sim.worker.js dist/terrain.worker.js dist/mc_route_bg.wasm

"${BUN[@]}" build ./index.html --compile --target=browser --outfile=dist/datastream_viewer.html
"${BUN[@]}" build ./src/data/workers/parse.worker.js --target=browser --format=esm --outfile=dist/workers/parse.worker.js
"${BUN[@]}" build ./src/flow/flow.worker.js --target=browser --format=esm --outfile=dist/flow.worker.js
"${BUN[@]}" build ./src/flow/terrain.worker.js --target=browser --format=esm --outfile=dist/terrain.worker.js
"${BUN[@]}" build ./src/sim/sim.worker.js --target=browser --format=esm --outfile=dist/sim.worker.js
cp src/vendor/mc_route/mc_route_bg.wasm dist/mc_route_bg.wasm

test -s dist/datastream_viewer.html || { echo "bun produced no dist/datastream_viewer.html" >&2; exit 1; }
echo "Built dist/datastream_viewer.html + dist/workers/parse.worker.js + dist/{flow,terrain,sim}.worker.js + dist/mc_route_bg.wasm"
