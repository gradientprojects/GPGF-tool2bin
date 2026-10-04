#!/bin/bash
# run a .cjs harness through node -e (the replicad wasm module resolves
# to ESM when require()d by path from a file; -e keeps it CommonJS)
set -e
script="$1"
shift
cd "$(dirname "$0")/.."
node --input-type=commonjs -e "$(cat "$script")" -- "$@"
