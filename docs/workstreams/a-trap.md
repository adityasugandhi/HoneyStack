# Workstream A: Trap app

**Goal:** the public fake app. An attacker finds a leaked token and a command-injection bug, confirms "RCE", and fires a reverse-shell payload. The trap then opens a real TCP connection to their listener and relays their commands to the shell brain. **Nothing the attacker sends is ever executed.**

## You own
- `apps/trap/` (`server.mjs`, `shell-connector.mjs`, `public/`)
- `packages/trap/response-map.json`
- `Dockerfile.trap`

## Read first
- [`../contracts.md`](../contracts.md): C1 (shell API you call), C2 (events you send), environment variables
- `HoneyStack Implementation.txt` §5 (bait routes, capture, handler outline) and §6 (event format)
- [`../llm-shell-demo.md`](../llm-shell-demo.md) §1: the attack, step by step

## Work before the shell brain is ready (mock)
Run a 20-line stub control server on port 8080 that implements C1 by returning `bash: <cmd>: command not found` for every command, and logs `/v1/events/batch` bodies to stdout.

## Tasks
- [ ] Node built-ins only (`http`, `net`, `crypto`); no npm dependencies in the trap.
- [ ] Fake "Hivewell Status" page in `public/status.html` (linked as "System status" from the Hivewell marketing site): looks like a Next.js ops dashboard. Its source has a `// TODO remove before prod` comment and a `fetch('/api/admin/diagnostics', ...)` call.
- [ ] Bait routes `/api/login`, `/api/env` (leaks `ADMIN_TOKEN=synthetic_...`), and `/api/exec` per §5.1.
- [ ] `POST /api/admin/diagnostics {"host": "..."}` (requires the leaked token): for a plain host, return canned `ping -c 1` output.
- [ ] Injection detector: split `host` on `;`, `|`, `&&`, `||`, `$(`, and backticks. The first part gets ping output; each extra command goes to `/v1/shell/oneshot`; concatenate the outputs.
- [ ] Reverse-shell parser: detect `/dev/tcp/IP/PORT`, `nc IP PORT -e …`, `ncat`, `sh -i` with an IP and port, and `python -c` socket one-liners. Extract the IP and port.
- [ ] `shell-connector.mjs`: if the IP is in `CALLBACK_ALLOWLIST`, call `/v1/shell/open`, `net.connect(port, ip)`, write the banner and prompt, then loop: read a line → `/v1/shell/cmd` → wait `delay_ms` → write output + prompt. Not on the allowlist → log a `revshell-blocked` event and connect to nothing.
- [ ] Hold the diagnostics HTTP request open for ~30 s after a reverse-shell payload, as a real `bash -i` would.
- [ ] Limits: 1 live shell at a time, 15 min max, 2 min idle, 16 KiB per line, 16 KiB request bodies.
- [ ] Every HTTP request → one event to `/v1/events/batch` (§5.2 redaction rules). Create the `session_id` on the first request from an IP and reuse it for the callback.
- [ ] A test that fails if `child_process`, `eval(`, `new Function`, or `vm` appears anywhere in `apps/trap/`.
- [ ] `Dockerfile.trap` per §11 (non-root `node` user).

## Done when
Locally, with the stub (or B's real) control server: `curl` the injection payload pointing at `127.0.0.1:4444` → `nc -lvnp 4444` shows the banner and prompt → typed commands come back with responses, and events appear in the control server.

## Hand-offs
- **To F:** a working `Dockerfile.trap` by checkpoint 3.
- **To B:** tell them any odd command patterns you see in testing.
