#!/usr/bin/env bash
# Downloads the official Spine example skeleton (spineboy) from the
# spine-runtimes repository. These assets are owned by Esoteric Software
# and are NOT redistributed with this repository — see NOTICE.md.
set -euo pipefail

BASE="https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/4.3/examples/spineboy/export"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/spineboy"

mkdir -p "$DEST"
for f in spineboy-ess.json spineboy-pro.json spineboy.atlas spineboy.png; do
  echo "fetching $f"
  curl -fsSL "$BASE/$f" -o "$DEST/$f"
done
echo "done → $DEST"
