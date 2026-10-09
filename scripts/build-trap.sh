#!/bin/sh
# Usage: REGISTRY=ghcr.io/you sh scripts/build-trap.sh
set -eu
: "${REGISTRY:?set REGISTRY}"
TAG="${TAG:-demo-1}"
npm run build:css
docker build -f Dockerfile.trap -t "$REGISTRY/honeystack-trap:$TAG" .
echo "Built $REGISTRY/honeystack-trap:$TAG"
echo "Push, then record the digest: docker inspect --format='{{index .RepoDigests 0}}' $REGISTRY/honeystack-trap:$TAG"
