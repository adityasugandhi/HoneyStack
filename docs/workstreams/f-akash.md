# Workstream F: Akash hosting + demo lead

**Goal:** the trap container runs on Akash at a public URI, it can reach the private control server over HTTPS, and the full attack works from the attacker laptop. You also own the demo script and run the rehearsal as the attacker.

**Don't read `packages/shell/world.json`.** You play the attacker in rehearsal, and the point is to find what feels fake to someone seeing it for the first time.

## You own
- `deploy/` (Akash SDL, tunnel/relay config, scripts)
- `deploy/RUNBOOK.md` (attacker run sheet and cleanup log)
- `.dockerignore`

You *use* `Dockerfile.trap` and `apps/trap/` but A owns them. Ask A for changes.

## Read first
- [`../contracts.md`](../contracts.md): the environment variables table and the shell API (your tunnel must expose these routes)
- `HoneyStack Implementation.txt` §11 (container build), §12 (Akash SDL, deployment and cleanup), and §2 (safety)

## Work before the trap is ready (mock)
Deploy a hello-world container first (e.g. `nginxdemos/hello`, or a 5-line Node server on port 3000). This proves the account, billing, bid denomination, and service URI before A's image exists.

## Tasks
- [ ] Confirm the Akash Console account, billing mode, and credits. Record the bid denomination the Console actually accepts (`uact` vs `uakt`; see §12.1).
- [ ] Deploy hello-world. Record the deployment ID and service URI. Check `GET /` from your laptop.
- [ ] Find the egress IP the Akash provider uses for outbound connections (run a tiny container that calls `https://ifconfig.me` and logs it). This is the IP the attacker's `nc` will see.
- [ ] Set up the HTTPS route from Akash to the control server (on a teammate's laptop): e.g. Cloudflare Tunnel or ngrok. It must expose **only** `/v1/shell/*` and `/v1/events/batch`, never the dashboard or `/v1/analyze`.
- [ ] Choose how to deliver `INGEST_TOKEN` to the container without putting it in a published SDL (§12.1). If nothing safe is available, use a short-lived token and revoke it after the demo.
- [ ] Write `deploy/akash.yaml` from the §12.1 template with `CONTROL_URL`, `CALLBACK_ALLOWLIST=<attacker laptop public IP>`, `TRAP_INSTANCE_ID=demo-1`, and port 3000 exposed as 80.
- [ ] Get A's image (by checkpoint 3), push it to a registry, pin the digest, and deploy it.
- [ ] Check outbound TCP from the provider works: the reverse-shell callback needs the container to open a connection to your laptop's port 4444. If the venue network blocks inbound to your laptop, use a phone hotspot or a small VPS as the attacker box.
- [ ] Write `deploy/RUNBOOK.md`: the exact `curl` and `nc` commands in demo order (`llm-shell-demo.md` §1), with `$TRAP_URL` and `$MY_IP` placeholders.
- [ ] Rehearse as the attacker against the Akash URI. Note every "wait, that's weird" moment and send each one to B.
- [ ] Record a backup run with `asciinema rec` and label it as a recording.
- [ ] After the demo: run the §12.3 cleanup (revoke token, close lease, confirm closed state, check billing) and log it in the runbook.

## Done when
From the attacker laptop, `curl` against the Akash URI → injection → `nc -lvnp 4444` receives a shell → commands land in ClickHouse and show on the dashboard. The deployment ID, image digest, and service URI are recorded in `deploy/RUNBOOK.md`.

## Hand-offs
- **From A:** a trap image that builds with `docker build -f Dockerfile.trap .` (by checkpoint 3).
- **From B/C:** the control server running locally on port 8080, so you can point the tunnel at it.
- **To everyone:** the tunnel URL (= `CONTROL_URL`) and the Akash service URI, posted in team chat.
