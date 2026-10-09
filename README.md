# HoneyStack

A honeypot where the attacker's "reverse shell" is an LLM pretending to be bash. Built on Akash, ClickHouse, and Guild AI.

- **Start here:** [`docs/work-split.md`](docs/work-split.md) — pick a workstream
- **Using a coding agent:** tell it your workstream; it reads [`AGENTS.md`](AGENTS.md)
- Demo scenario: [`docs/llm-shell-demo.md`](docs/llm-shell-demo.md)
- Interfaces between workstreams: [`docs/contracts.md`](docs/contracts.md)
- Akash plan: [`deploy/AKASH_PLAN.md`](deploy/AKASH_PLAN.md)

## Architecture

![HoneyStack architecture: attacker to trap (Akash) to control server to Guild and ClickHouse to dashboard](assets/architecture.svg)

The attacker exploits the fake Hivewell app on **Akash** and gets a "reverse shell" that is really a **Guild** agent playing bash. The **control server** answers each command (fast path from `world.json`, else Guild) and is the only writer to **ClickHouse**; a second Guild agent turns a session into the playbook shown on the dashboard. Full detail with sequence diagrams: [`docs/architecture.md`](docs/architecture.md).

## Akash deployment (Workstream F)

The trap runs on Akash. Current demo deployment:

| Field | Value |
|---|---|
| Live URL | http://ve9t9r8ep99cl0pfaqremov764.ingress.zencloud.eu/ |
| DSEQ | `1791581948124` |
| Provider | zencloud.eu (`akash16yr3wxt…`) |
| Image | `ghcr.io/adityasugandhi/honeystack-trap@sha256:2801db47…` (public, amd64) |
| Status | Trap serving (`/health` → `{"status":"ok"}`). Bait routes return `503` until the control server + tunnel are wired (set `CONTROL_URL`/`INGEST_TOKEN`/`CALLBACK_ALLOWLIST` in `deploy/akash.yaml`). |

### Deploy / redeploy

```sh
# build + push the amd64 image (needs: docker login ghcr.io), then pin its digest in deploy/akash.yaml
REGISTRY=ghcr.io/adityasugandhi sh scripts/build-trap.sh
docker buildx imagetools inspect ghcr.io/adityasugandhi/honeystack-trap:demo-1

# deploy the trap SDL (akash_key must be in .env)
sh scripts/deploy-trap.sh
sh scripts/close-deployment.sh <DSEQ>        # cleanup
```

**Gotchas we hit** (so nobody loses an hour to them again):
- The image **must be `linux/amd64`** — `build-trap.sh` cross-builds with buildx (Macs are arm64).
- The GHCR package **must be public** (Akash providers pull anonymously), or add a `credentials:` block to the SDL.
- Some providers accept the lease and run the container but their **HTTP ingress returns an nginx `404`** (froggy-servers did this). The container is fine — redeploy excluding that provider:
  ```sh
  SKIP_PROVIDERS=<bad-provider-address> sh scripts/deploy-trap.sh
  ```
