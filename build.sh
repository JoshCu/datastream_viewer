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
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist/datastream_viewer.html dist/workers

bun build ./index.html --compile --target=browser --outfile=dist/datastream_viewer.html
bun build ./src/data/workers/parse.worker.js --target=browser --format=esm --outfile=dist/workers/parse.worker.js

echo "Built dist/datastream_viewer.html + dist/workers/parse.worker.js"
