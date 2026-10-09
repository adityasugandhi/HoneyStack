#!/bin/sh
# Usage: TARGET=http://localhost:3000 sh scripts/smoke.sh   (operator-controlled targets only; no redirects followed)
set -eu
: "${TARGET:?set TARGET}"
SID="${SESSION_ID:-00000000-0000-4000-8000-000000000001}"
c() { curl -sS --max-redirs 0 -m 10 -H "x-demo-session: $SID" "$@"; echo; }
c "$TARGET/health"
c -X POST -H 'content-type: application/json' -d '{"user":"demo"}' "$TARGET/api/login"
c "$TARGET/api/env"
c -X POST -H 'content-type: application/json' -d '{"task":"demo-action"}' "$TARGET/api/exec"
