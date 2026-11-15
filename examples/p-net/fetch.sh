#!/usr/bin/env bash
# Fetch the rt-labs p-net PROFINET device stack documented by this example into ./src (gitignored).
# The stack is GPLv3 or commercial; its sources are not part of this repository.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
COMMIT=1c3b0b435b2ee2c6cea86849c14ee98f6ee579f1
if [ -d src/.git ]; then
  echo "src/ already present; skipping clone"
  exit 0
fi
git clone https://github.com/rtlabs-com/p-net.git src
git -C src checkout --quiet "$COMMIT"
