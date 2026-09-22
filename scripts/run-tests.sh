#!/usr/bin/env bash
# Compile tests (src + test -> test-build) and run them with the node:test
# runner against temporary fixtures only — never real ~/.dsh data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/link-deps.mjs

echo "=== Compiling tests (src + test -> test-build) ==="
node_modules/.bin/tsc -p tsconfig.test.json

echo "=== Running tests (node:test) ==="
node --test "test-build/test/"*.test.js
