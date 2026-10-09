#!/bin/sh
# Rewrite the live-deploy table in README.md between the AKASH-DEPLOY markers.
# Usage: sh scripts/update-readme.sh <DSEQ> <URI> <IMAGE> [CONTROL_URL]
set -eu
DSEQ="${1:?DSEQ}"; URI="${2:-}"; IMAGE="${3:-}"; CONTROL_URL="${4:-}"
README=README.md
TS=$(date -u +"%Y-%m-%d %H:%M UTC")
URL_CELL="http://$URI/"
[ -z "$URI" ] && URL_CELL="_(pending — provider ingress not ready at deploy time)_"

BLOCK=$(cat <<EOF
| Field | Value |
|---|---|
| Live trap URL | $URL_CELL |
| DSEQ | \`$DSEQ\` |
| Image | \`$IMAGE\` |
| Control tunnel | $CONTROL_URL |
| Updated | $TS (auto, CI) |
EOF
)

awk -v block="$BLOCK" '
  /<!-- AKASH-DEPLOY:START -->/ { print; print block; skip=1; next }
  /<!-- AKASH-DEPLOY:END -->/   { skip=0 }
  !skip { print }
' "$README" > "$README.tmp" && mv "$README.tmp" "$README"
echo "README updated: $URL_CELL (DSEQ $DSEQ)"
