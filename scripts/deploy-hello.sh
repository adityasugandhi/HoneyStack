#!/bin/sh
# Workstream F — hello-world deploy to prove account/billing/denomination.
# Usage: sh scripts/deploy-hello.sh
set -eu

# Load .env; our key variable is akash_key
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
AKASH_API_KEY="${AKASH_API_KEY:-${akash_key:-}}"
: "${AKASH_API_KEY:?akash_key or AKASH_API_KEY must be set in .env}"

API=https://console-api.akash.network
SDL=$(cat deploy/hello-world.yaml)

echo "=== Step 1: account balance (USD micro-units) ==="
curl -s "$API/v1/balances" -H "x-api-key: $AKASH_API_KEY" | jq '.data'

echo ""
echo "=== Step 2: create deployment ==="
RESPONSE=$(curl -sX POST "$API/v1/deployments" \
  -H "x-api-key: $AKASH_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg sdl "$SDL" '{data: {sdl: $sdl, name: "honeystack-hello-world"}}')")

DSEQ=$(echo "$RESPONSE" | jq -r '.data.dseq // empty')
if [ -z "$DSEQ" ]; then
  echo "ERROR creating deployment:"
  echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
  exit 1
fi
echo "Deployment DSEQ: $DSEQ"

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

echo ""
echo "=== Bids ==="
echo "$BIDS" | jq -r '.data[] | select(.bid.state == "open") | "\(.bid.price.amount) \(.bid.price.denom)  \(.bid.id.provider)"' | sort -n

echo ""
echo "=== Step 4: accept cheapest bid ==="
BID=$(echo "$BIDS" | jq -c '[.data[] | select(.bid.state == "open")] | sort_by(.bid.price.amount | tonumber) | .[0].bid.id')
echo "Accepting: $(echo "$BID" | jq -c '{provider, dseq}')"
LEASE=$(curl -sX POST "$API/v1/leases" \
  -H "x-api-key: $AKASH_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson id "$BID" '{leases: [{dseq: $id.dseq, gseq: $id.gseq, oseq: $id.oseq, provider: $id.provider}]}')")
echo "$LEASE" | jq -r '.data.leases[0].id // .error // "lease response unexpected"'

echo ""
echo "=== Step 5: wait for service URI (up to 120s) ==="
HOST=""
for i in $(seq 1 24); do
  STATUS=$(curl -s "$API/v1/deployments/$DSEQ" -H "x-api-key: $AKASH_API_KEY")
  HOST=$(echo "$STATUS" | jq -r '.data.leases[0].status.services.web.uris[0] // empty' 2>/dev/null || true)
  AVAIL=$(echo "$STATUS" | jq -r '.data.leases[0].status.services.web.available // 0' 2>/dev/null || true)
  echo "  attempt $i: available=$AVAIL uri=${HOST:-pending}"
  [ -n "$HOST" ] && break
  sleep 5
done

echo ""
echo "=== RESULT ==="
echo "Deployment DSEQ : $DSEQ"
echo "Service URI     : ${HOST:-not ready yet}"
echo "Close when done : sh scripts/close-deployment.sh $DSEQ"
