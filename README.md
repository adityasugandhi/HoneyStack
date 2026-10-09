# HoneyStack

A honeypot where the attacker's "reverse shell" is an LLM pretending to be bash. Built on Akash, ClickHouse, and Guild AI.

- **Start here:** [`docs/work-split.md`](docs/work-split.md) — pick a workstream
- **Using a coding agent:** tell it your workstream; it reads [`AGENTS.md`](AGENTS.md)
- Demo scenario: [`docs/llm-shell-demo.md`](docs/llm-shell-demo.md)
- Interfaces between workstreams: [`docs/contracts.md`](docs/contracts.md)
- Akash plan: [`deploy/AKASH_PLAN.md`](deploy/AKASH_PLAN.md)

## The pitch

**Watch someone "hack" a company live — then watch the reveal that none of it was real.**

Classic honeypots are static: a real attacker (or an autonomous AI agent) fingerprints the canned responses in seconds and leaves, and you learn nothing. HoneyStack makes the "reverse shell" a **live LLM playing bash**. It never breaks character, keeps a consistent fake filesystem, feeds tempting dead-ends, and **wastes the attacker's time** while recording every keystroke. A second agent then turns the session into an analyst report — classification, kill-chain, credentials targeted — with every claim linked to the exact command that proves it.

The target is **Hivewell**, a fake Vermont smart-beehive startup. The live demo (~5 min attack, 1 min reveal):

1. **Recon** — `robots.txt` and a careers post point at the engineers' internal `/status` board.
2. **Token leak** — the page source ships a hard-coded `ADMIN_TOKEN`; `/api/env` dumps fake DB creds.
3. **Injection** — `{"host":"8.8.8.8; id"}` returns `uid=1000(node)` — "RCE confirmed."
4. **Reverse shell** — the payload opens a **real TCP connection** to the attacker's own `nc` listener. Nothing about netcat reveals the bytes are AI-generated.
5. **Post-exploitation** — `cat .env.production`, `psql` (hangs, then times out), `~/.aws/credentials` ("jackpot") — all invented, all consistent.
6. **Reveal** — flip to the HoneyStack Shield dashboard: live timeline, a "time wasted" counter, and the analyst's kill-chain, each step linked to its evidence.

> *"Every byte they saw was invented. We know who they are and what they were after — and they burned twelve minutes on a machine that doesn't exist."*

**Built on three sponsors, for real:** **Akash** hosts the public trap container · **ClickHouse** stores every HTTP event and shell command · **Guild AI** runs two agents — one plays bash per session, one writes the evidence-linked report.

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
