#!/usr/bin/env bash
# Builds the mc_route routing kernel (wasm/mc_route) into src/vendor/mc_route/.
#
# The output is committed so the site still has no build step: `bun serve.js`
# and GitHub Pages serve it as-is. Only rerun this after touching wasm/.
# Needs wasm-pack and the wasm32-unknown-unknown target. Pass --debug for a
# build with console_error_panic_hook, so a kernel panic logs a Rust message.
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--debug" ]]; then
  wasm-pack build wasm/mc_route --target web --dev --features debug \
    --out-dir ../../src/vendor/mc_route --no-pack
else
  wasm-pack build wasm/mc_route --target web --release \
    --out-dir ../../src/vendor/mc_route --no-pack
fi
# wasm-pack writes a .gitignore that ignores everything, but the output is
# meant to be committed.
rm -f src/vendor/mc_route/.gitignore

ls -l src/vendor/mc_route/
