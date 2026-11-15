#!/usr/bin/env bash
# Fetch the rt-labs i-link IO-Link master stack documented by this example into ./src (gitignored).
# The stack is GPLv3 or commercial; its sources are not part of this repository.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
COMMIT=9f5fe0f7c6a45fa96a8d2439dcbe60bb2415793d
if [ -d src/.git ]; then
  echo "src/ already present; skipping clone"
  exit 0
fi
git clone https://github.com/rtlabs-com/i-link.git src
git -C src checkout --quiet "$COMMIT"
