#!/bin/sh
# Rewrite the live-deploy table in README.md between the AKASH-DEPLOY markers.
# Usage: sh scripts/update-readme.sh <DSEQ> <URI> <IMAGE> [CONTROL_URL]
set -eu
DSEQ="${1:?DSEQ}"; URI="${2:-}"; IMAGE="${3:-}"; CONTROL_URL="${4:-}"
export DSEQ URI IMAGE CONTROL_URL README=README.md
python3 - <<'PY'
import os, datetime
README = os.environ["README"]
dseq, uri = os.environ["DSEQ"], os.environ["URI"]
image = os.environ["IMAGE"]
tunnel = os.environ.get("CONTROL_URL", "")
ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
url_cell = f"http://{uri}/" if uri else "_(pending — provider ingress not ready at deploy time)_"
block = (
    "| Field | Value |\n|---|---|\n"
    f"| Live trap URL | {url_cell} |\n"
    f"| DSEQ | `{dseq}` |\n"
    f"| Image | `{image}` |\n"
    f"| Control (dashboard) | {tunnel} |\n"
    f"| Updated | {ts} (auto, CI) |\n"
)
src = open(README).read()
start = src.index("<!-- AKASH-DEPLOY:START -->") + len("<!-- AKASH-DEPLOY:START -->")
end = src.index("<!-- AKASH-DEPLOY:END -->")
open(README, "w").write(src[:start] + "\n" + block + "\n" + src[end:])
print(f"README updated: {url_cell} (DSEQ {dseq})")
PY