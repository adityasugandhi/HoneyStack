#!/bin/sh
# Workstream F — close an Akash deployment lease (spec 12.3 cleanup).
# Usage: sh scripts/close-deployment.sh <DSEQ>
set -eu
DSEQ="${1:?usage: sh scripts/close-deployment.sh <DSEQ>}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
AKASH_API_KEY="${AKASH_API_KEY:-${akash_key:-}}"
: "${AKASH_API_KEY:?akash_key or AKASH_API_KEY must be set in .env}"
API=https://console-api.akash.network

echo "Closing deployment $DSEQ ..."
curl -sX DELETE "$API/v1/deployments/$DSEQ" -H "x-api-key: $AKASH_API_KEY" | jq '.' 2>/dev/null || echo "(no body)"
echo ""
echo "Confirming state ..."
curl -s "$API/v1/deployments/$DSEQ" -H "x-api-key: $AKASH_API_KEY" | jq '.data.state // .data | {state: (.state // "unknown")}'
