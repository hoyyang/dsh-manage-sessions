#!/usr/bin/env bash
# Build host + client from one local, pinned toolchain. No network install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/link-deps.mjs

if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/tsdown ]; then
  echo "build: tsc/tsdown development links are unavailable" >&2
  exit 1
fi

echo "=== Compiling host (src -> lib) ==="
node_modules/.bin/tsc -p tsconfig.json
echo "=== Typechecking client ==="
node_modules/.bin/tsc -p tsconfig.client.json
echo "=== Bundling client (src/client -> lib/client.js) ==="
rm -f lib/client.js lib/client.js.map
node_modules/.bin/tsdown
node --input-type=module -e "const s=await import('node:fs/promises').then(m=>m.readFile('lib/client.js','utf8'));if(!s.includes('__ModuleLoader__'))throw new Error('lib/client.js has no __ModuleLoader__ banner')"
echo "=== Build complete ==="
