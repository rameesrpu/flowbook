#!/usr/bin/env bash
# Fetch the Lua 5.4.7 sources documented by this example into ./src (gitignored).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [ -d src/.git ] || [ -f src/lua.c ]; then
  echo "src/ already present; skipping clone"
  exit 0
fi
git clone --depth 1 --branch v5.4.7 https://github.com/lua/lua.git src
