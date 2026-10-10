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
# Guard against an unrendered template — but ignore comment lines, which may
# mention ${PLACEHOLDERS} in prose without being real values.
if printf '%s\n' "$SDL" | grep -v '^[[:space:]]*#' | grep -q '[$]{'; then
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

echo "=== wait for trap URI (the ingress comes up fast once the lease is active) ==="
HOST=""
for i in $(seq 1 36); do
  # Strip control chars: the provider status embeds raw bytes that break jq otherwise.
  ST=$(curl -s "$API/v1/deployments/$DSEQ" -H "x-api-key: $AKASH_API_KEY" | tr -d '\000-\010\013\014\016-\037')
  HOST=$(echo "$ST" | jq -r '.data.leases[0].status.services.trap.uris[0] // empty' 2>/dev/null || true)
  echo "  attempt $i: trap uri=${HOST:-pending}"
  [ -n "$HOST" ] && break
  sleep 5
done

echo ""
echo "DSEQ: $DSEQ"
echo "Service URI: ${HOST:-not-ready-yet}"
# Multi-service SDLs (trap + control): surface the control (dashboard) URI too.
if [ -n "${ST:-}" ]; then
  CTL_URI=$(printf '%s' "$ST" | tr -d '\000-\010\013\014\016-\037' | jq -r '.data.leases[0].status.services.control.uris[0] // empty' 2>/dev/null || true)
  [ -n "$CTL_URI" ] && echo "Control URI: $CTL_URI"
fi
if [ -n "$HOST" ]; then
  echo "=== trap /health ==="
  curl -s -m 10 "http://$HOST/health" || true; echo
  [ -n "$CTL_URI" ] && { echo "=== control /health ==="; curl -s -m 10 "http://$CTL_URI/health" || true; echo; }
fi

# One trap at a time: close every other active honeystack lease (CD sets CLOSE_STALE=1).
# CRITICAL ORDERING: only close the old lease(s) AFTER the new one is confirmed
# serving (health 200). Never close before, or there's a gap with nothing live.
if [ "${CLOSE_STALE:-0}" = "1" ]; then
  NEW_OK=0
  if [ -n "$HOST" ]; then
    CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://$HOST/health" 2>/dev/null || echo 000)
    [ "$CODE" = "200" ] && NEW_OK=1
    echo "new trap health: HTTP $CODE"
  fi
  if [ "$NEW_OK" = "1" ]; then
    echo "=== new trap $DSEQ verified healthy; closing stale honeystack leases ==="
    curl -s "$API/v1/deployments" -H "x-api-key: $AKASH_API_KEY" \
      | tr -d '\000-\010\013\014\016-\037' \
      | jq -r --arg keep "$DSEQ" '.data.deployments[]
          | select(.deployment.state=="active")
          | select(.name // "" | startswith("honeystack"))
          | .deployment.id.dseq | select(. != $keep)' 2>/dev/null \
      | while read -r OLD; do
          [ -n "$OLD" ] || continue
          echo "  closing $OLD"
          curl -sX DELETE "$API/v1/deployments/$OLD" -H "x-api-key: $AKASH_API_KEY" >/dev/null 2>&1 || true
        done
  else
    echo "WARNING: new trap $DSEQ not confirmed healthy (uri=${HOST:-none}); keeping ALL leases so nothing goes dark. Clean up manually if needed."
  fi
fi

echo "Close with: sh scripts/close-deployment.sh $DSEQ"
