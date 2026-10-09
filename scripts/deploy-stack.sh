#!/bin/sh
# Deploy the multi-service HoneyStack SDL to Akash via the Console API.
# Usage: sh scripts/deploy-stack.sh [rendered-sdl.yaml]
# AKASH_API_KEY from env (CI) or .env (local). SKIP_PROVIDERS optional (comma list).
set -eu
SDL_FILE="${1:-deploy/akash-full.yaml}"
[ -f "$SDL_FILE" ] || { echo "SDL not found: $SDL_FILE" >&2; exit 1; }
if [ -z "${AKASH_API_KEY:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
AKASH_API_KEY="${AKASH_API_KEY:-${akash_key:-}}"
: "${AKASH_API_KEY:?AKASH_API_KEY must be set}"

API=https://console-api.akash.network
SDL=$(cat "$SDL_FILE")
if echo "$SDL" | grep -q '${'; then
  echo "ERROR: SDL still has unrendered \${...} placeholders — run envsubst first." >&2
  exit 1
fi

echo "=== create deployment ==="
RESP=$(curl -sX POST "$API/v1/deployments" -H "x-api-key: $AKASH_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg sdl "$SDL" '{data:{sdl:$sdl,name:"honeystack-stack"}}')")
DSEQ=$(echo "$RESP" | jq -r '.data.dseq // empty')
[ -z "$DSEQ" ] && { echo "ERROR creating deployment:"; echo "$RESP" | jq . 2>/dev/null || echo "$RESP"; exit 1; }
echo "DSEQ: $DSEQ"

echo "=== wait for bids (up to 90s) ==="
SKIP_PROVIDERS="${SKIP_PROVIDERS:-}"
COUNT=0
for i in $(seq 1 18); do
  BIDS=$(curl -s "$API/v1/bids?dseq=$DSEQ" -H "x-api-key: $AKASH_API_KEY")
  COUNT=$(echo "$BIDS" | jq '[.data[]|select(.bid.state=="open")]|length' 2>/dev/null || echo 0)
  echo "  attempt $i: $COUNT open bid(s)"
  [ "$COUNT" -gt 0 ] && break
  sleep 5
done
[ "$COUNT" -eq 0 ] && { echo "ERROR: no bids after 90s (a 2-service deployment needs a provider with capacity for both)." >&2; exit 1; }

[ -n "$SKIP_PROVIDERS" ] && echo "(excluding providers: $SKIP_PROVIDERS)"
BID=$(echo "$BIDS" | jq -c --arg skip "$SKIP_PROVIDERS" '
  ($skip|split(",")|map(select(length>0))) as $x
  | [.data[]|select(.bid.state=="open")|select((.bid.id.provider as $p|$x|index($p))|not)]
  | sort_by(.bid.price.amount|tonumber)|.[0].bid.id // empty')
[ -z "$BID" ] && { echo "ERROR: no open bids left after SKIP_PROVIDERS." >&2; exit 1; }
echo "accepting provider: $(echo "$BID" | jq -r .provider)"

echo "=== accept bid ==="
curl -sX POST "$API/v1/leases" -H "x-api-key: $AKASH_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson id "$BID" '{leases:[{dseq:$id.dseq,gseq:$id.gseq,oseq:$id.oseq,provider:$id.provider}]}')" \
  | jq -r '.data.leases[0].id // .error // "unexpected lease response"'

echo "=== wait for trap URI (up to 180s) ==="
HOST=""
for i in $(seq 1 36); do
  ST=$(curl -s "$API/v1/deployments/$DSEQ" -H "x-api-key: $AKASH_API_KEY")
  HOST=$(echo "$ST" | jq -r '.data.leases[0].status.services.trap.uris[0] // empty' 2>/dev/null || true)
  echo "  attempt $i: trap uri=${HOST:-pending}"
  [ -n "$HOST" ] && break
  sleep 5
done

echo ""
echo "DSEQ: $DSEQ"
echo "Service URI: ${HOST:-not-ready-yet}"
if [ -n "$HOST" ]; then
  echo "=== trap /health ==="
  curl -s -m 10 "http://$HOST/health" || true; echo
fi
echo "Close with: sh scripts/close-deployment.sh $DSEQ"
