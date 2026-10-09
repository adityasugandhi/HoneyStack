#!/bin/sh
# Build the trap image for Akash (amd64) and push it to a public registry.
# Usage: REGISTRY=ghcr.io/<you> sh scripts/build-trap.sh
#
# Akash providers run linux/amd64. These Macs are arm64, so a plain `docker build`
# produces an image providers cannot run — we must cross-build with buildx.
set -eu
: "${REGISTRY:?set REGISTRY, e.g. REGISTRY=ghcr.io/adityasugandhi}"
TAG="${TAG:-demo-1}"
IMAGE="$REGISTRY/honeystack-trap:$TAG"

npm run build:css

# buildx needs a builder; create one once (ignore error if it exists).
docker buildx create --name honeystack --use >/dev/null 2>&1 || docker buildx use honeystack

# Cross-build amd64 and push in one step (buildx can't --load a cross-arch image).
docker buildx build --platform linux/amd64 -f Dockerfile.trap -t "$IMAGE" --push .

echo "Pushed $IMAGE (linux/amd64)"
echo "Record the digest for the SDL:"
echo "  docker buildx imagetools inspect $IMAGE"
echo "Then use  $REGISTRY/honeystack-trap@sha256:<digest>  in deploy/akash.yaml"
