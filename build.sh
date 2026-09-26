#!/usr/bin/env bash
# Builds the standalone dist/datastream_viewer.html plus its sidecar worker.
#
# Bun's HTML bundler doesn't understand `new Worker(new URL(...))` — it leaves
# that call untouched rather than splitting/rewriting it (true for --compile
# single-file output and for plain --outdir output alike). So the worker has
# to be built as its own entrypoint and placed at dist/workers/parse.worker.js
# to match the relative path hardcoded in loader.js. The inline module script
# that --compile produces resolves import.meta.url to the HTML document's own
# URL, so this sidecar path is resolved relative to wherever the html file is
# served from.
#
# The live-routing wasm (src/vendor/mc_route) is the same story: the glue's
# `new URL("mc_route_bg.wasm", import.meta.url)` is left as-is, so it resolves
# next to the html file and the binary is copied there. That glue is built by
# ./build-wasm.sh and committed; this script doesn't rebuild it.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist/datastream_viewer.html dist/workers dist/mc_route_bg.wasm

bun build ./index.html --compile --target=browser --outfile=dist/datastream_viewer.html
bun build ./src/data/workers/parse.worker.js --target=browser --format=esm --outfile=dist/workers/parse.worker.js
cp src/vendor/mc_route/mc_route_bg.wasm dist/mc_route_bg.wasm

echo "Built dist/datastream_viewer.html + dist/workers/parse.worker.js + dist/mc_route_bg.wasm"
