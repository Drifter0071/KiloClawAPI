#!/usr/bin/env bash
# Build a single self-contained binary. Defaults to the Debian target;
# pass BUILD_TARGET=local to build for the current OS (for dev/smoke).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${BUILD_TARGET:-debian}"
if [ "$TARGET" = "debian" ]; then
  bun build --compile --target=bun-linux-x64 --outfile=cmms-api src/index.ts
else
  bun build --compile --outfile=cmms-api src/index.ts
fi
echo "Built ./cmms-api ($(wc -c < cmms-api) bytes)"
