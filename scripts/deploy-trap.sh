#!/bin/sh
# Workstream F — deploy the trap SDL (deploy/akash.yaml) to Akash via Console API.
# Prereq: the image in deploy/akash.yaml is pushed (public GHCR) and digest-pinned.
# Usage: sh scripts/deploy-trap.sh
set -eu

if [ -f .env ]; then set -a; . ./.env; set +a; fi
AKASH_API_KEY="${AKASH_API_KEY:-${akash_key:-}}"
: "${AKASH_API_KEY:?akash_key or AKASH_API_KEY must be set in .env}"

API=https://console-api.akash.network
SDL_FILE=deploy/akash.yaml
SDL=$(cat "$SDL_FILE")

# Guard: refuse to deploy an unpinned placeholder image.
if echo "$SDL" | grep -q 'REPLACE_WITH_PINNED_IMAGE'; then
  echo "ERROR: $SDL_FILE still has REPLACE_WITH_PINNED_IMAGE. Pin the digest first." >&2
  exit 1
fi

echo "=== Step 1: balance ==="
curl -s "$API/v1/balances" -H "x-api-key: $AKASH_API_KEY" | jq '.data'

echo ""
echo "=== Step 2: create deployment ==="
RESPONSE=$(curl -sX POST "$API/v1/deployments" \
  -H "x-api-key: $AKASH_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg sdl "$SDL" '{data: {sdl: $sdl, name: "honeystack-trap"}}')")
DSEQ=$(echo "$RESPONSE" | jq -r '.data.dseq // empty')
if [ -z "$DSEQ" ]; then echo "ERROR:"; echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"; exit 1; fi
echo "DSEQ: $DSEQ"

echo ""
echo "=== Step 3: wait for bids (up to 60s) ==="
COUNT=0
for i in $(seq 1 12); do
  BIDS=$(curl -s "$API/v1/bids?dseq=$DSEQ" -H "x-api-key: $AKASH_API_KEY")
  COUNT=$(echo "$BIDS" | jq '[.data[] | select(.bid.state == "open")] | length' 2>/dev/null || echo 0)
  echo "  attempt $i: $COUNT open bid(s)"
  [ "$COUNT" -gt 0 ] && break
  sleep 5
done
[ "$COUNT" -eq 0 ] && echo "ERROR: no bids after 60s." && exit 1
echo "$BIDS" | jq -r '.data[] | select(.bid.state=="open") | "\(.bid.price.amount) \(.bid.price.denom)  \(.bid.id.provider)"' | sort -n

echo ""
echo "=== Step 4: accept cheapest ==="
BID=$(echo "$BIDS" | jq -c '[.data[] | select(.bid.state=="open")] | sort_by(.bid.price.amount|tonumber) | .[0].bid.id')
curl -sX POST "$API/v1/leases" \
  -H "x-api-key: $AKASH_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson id "$BID" '{leases: [{dseq:$id.dseq,gseq:$id.gseq,oseq:$id.oseq,provider:$id.provider}]}')" \
  | jq -r '.data.leases[0].id // .error // "unexpected lease response"'

echo ""
echo "=== Step 5: wait for service URI (up to 150s) ==="
HOST=""
for i in $(seq 1 30); do
  STATUS=$(curl -s "$API/v1/deployments/$DSEQ" -H "x-api-key: $AKASH_API_KEY")
  HOST=$(echo "$STATUS" | jq -r '.data.leases[0].status.services.trap.uris[0] // empty' 2>/dev/null || true)
  AVAIL=$(echo "$STATUS" | jq -r '.data.leases[0].status.services.trap.available // 0' 2>/dev/null || true)
  echo "  attempt $i: available=$AVAIL uri=${HOST:-pending}"
  [ -n "$HOST" ] && break
  sleep 5
done

echo ""
echo "=== RESULT ==="
echo "DSEQ        : $DSEQ"
echo "Service URI : ${HOST:-not ready yet}"
echo "Health check: curl http://${HOST:-<URI>}/health"
echo "Close       : sh scripts/close-deployment.sh $DSEQ"
