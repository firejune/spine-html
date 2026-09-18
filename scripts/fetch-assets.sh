#!/usr/bin/env bash
# Downloads the official Spine example skeleton (spineboy) from the
# spine-runtimes repository. These assets are owned by Esoteric Software
# and are NOT redistributed with this repository — see NOTICE.md.
#
# SPINE_ASSETS_BRANCH picks which spine-runtimes branch to take them from, and
# therefore which editor version exported them. It defaults to 4.3, so a plain
# run is byte-identical to what this script always did. The CI matrix sets it
# per column: a runtime only reads data its own generation exported (see
# src/coreCompat.ts), so "4.2 is supported" means the 4.2 runtime rendering
# 4.2's own exports, and the column has to fetch them.
#
# The files land where the demo already looks for them (`public/spineboy`),
# whichever branch they came from — nothing downstream is told which one it is.
# The switch is therefore in the checkout, not in the code: two branches' assets
# are never present at once, which is why the destination is cleared when the
# branch changes rather than merged into.
set -euo pipefail

BRANCH="${SPINE_ASSETS_BRANCH:-4.3}"
BASE="https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/${BRANCH}/examples/spineboy/export"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/spineboy"
STAMP="$DEST/.branch"

# Idempotent: already-downloaded files are kept, so this is safe to run as a
# predev/prebuild hook (a fresh clone has no assets — they are gitignored).
# A *different* branch than last time is not idempotent, though: the exports
# would be mixed generation by generation, and the one that stayed behind would
# be the one that fails to parse. So switching branches starts clean.
#
# An unstamped directory is read as 4.3, not as unknown: before this script took
# a branch it only ever fetched 4.3, so that is what a checkout from then holds.
# Reading it as unknown would instead refetch every existing checkout once, for
# files it already has and that are already right.
PREVIOUS=4.3
if [ -f "$STAMP" ]; then PREVIOUS="$(cat "$STAMP")"; fi
if [ -d "$DEST" ] && [ "$PREVIOUS" != "$BRANCH" ]; then
  echo "assets branch $PREVIOUS → $BRANCH, refetching"
  rm -rf "$DEST"
fi

mkdir -p "$DEST"
# The stamp names the branch this directory is being filled from, so it is
# written before the downloads rather than after them: a run that dies halfway
# still leaves a directory that only ever held one branch's exports, and the
# next run resumes it instead of mixing a second branch into it.
printf '%s' "$BRANCH" > "$STAMP"

for f in spineboy-ess.json spineboy-pro.json spineboy-pro.skel spineboy.atlas spineboy.png; do
  if [ -s "$DEST/$f" ]; then
    echo "have $f"
  else
    echo "fetching $f"
    curl -fsSL "$BASE/$f" -o "$DEST/$f"
  fi
done
echo "assets ready (spine-runtimes $BRANCH) → $DEST"
