# Contracts between workstreams

Every workstream codes against these. Freeze them in the first 10 minutes. After that, a change needs a heads-up to the whole team, not just an edit.

## Process and file layout

```
apps/trap/                  A  public trap (Node built-ins only), deployed to Akash
apps/control/server.ts      C  thin router; registers each workstream's routes (see below)
apps/control/ingest.ts      C  /v1/events/batch + ClickHouse client + insertShellTurn()
apps/control/shell-brain.ts B  /v1/shell/* routes
apps/control/guild.ts       E  /v1/analyze, /v1/analysis/:id + polling worker
apps/dashboard/             D  private UI, served by the control server
packages/events/            all  shared types (schema.ts), frozen
packages/shell/world.json   B  the fake host
sql/                        C  ClickHouse migrations
agents/analysis.md          E  Guild agent prompt
deploy/                     F  Akash SDL, tunnel config, runbook
tests/fixtures/             all  demo-session.jsonl (C writes it at kickoff)
```

`apps/control/server.ts` is created at kickoff with all four registrations already wired up, so nobody else needs to edit it:

```ts
import { registerIngestRoutes } from './ingest';        // C
import { registerShellRoutes } from './shell-brain';    // B
import { registerAnalysisRoutes } from './guild';      // E
import { registerDashboard } from '../dashboard/serve'; // D
```

**Framework: Fastify** (`apps/control/server.ts`, run with `npm run dev:control`). B and E export `register*Routes(app)`; C's `apps/control/ingest.mjs` stays a plain Node request listener, and `server.ts` routes `/v1/events/batch` to it. Without `CLICKHOUSE_URL`, events and shell turns go to `data/*.jsonl` (dev mode).

Ports: trap `3000`, control server `8080`.

## C1. Shell API (trap → shell brain)

Every call carries `Authorization: Bearer $INGEST_TOKEN`. The control server is reached at `$CONTROL_URL` (a localhost URL in dev; the HTTPS tunnel URL on Akash).

```
POST /v1/shell/open
  req:  { "session_id": "uuid", "trigger_event_id": "uuid",
          "callback_ip": "1.2.3.4", "callback_port": 4444 }
  resp: { "banner": "bash: no job control in this shell\n",
          "prompt": "node@acme-status-7f9c4:/app$ " }

POST /v1/shell/cmd
  req:  { "session_id": "uuid", "seq": 1, "command": "ls -la" }
  resp: { "output": "...", "prompt": "node@acme-status-7f9c4:/app$ ",
          "served_by": "fast_path" | "llm" | "filter",
          "delay_ms": 350, "close": false }

POST /v1/shell/oneshot       # for the `; id` injection on /api/admin/diagnostics
  req:  { "session_id": "uuid", "command": "id" }
  resp: { "output": "uid=1000(node) gid=1000(node) groups=1000(node)\n" }
```

- The trap waits `delay_ms`, writes `output` and then `prompt` to the socket. `close: true` → the trap hangs up.
- The shell brain owns all session state. The trap stays stateless apart from the socket.
- Errors: `401` bad token, `429` session cap hit (the trap prints `Killed` and hangs up), `5xx` (the trap prints `bash: fork: retry: Resource temporarily unavailable` and keeps going).

## C2. Event and turn schema

HTTP events: exactly as in §6 of `HoneyStack Implementation.txt`, posted to `POST /v1/events/batch` (max 100 events or 256 KiB per batch). New route values: `/api/admin/diagnostics`. New `response_template` values: `diag-ping`, `diag-injected`, `revshell-callback`, `revshell-blocked`.

Shell turns (written by B via C's `insertShellTurn()`):

```sql
CREATE TABLE honeypot.shell_turns
(
  turn_id UUID,
  session_id UUID,
  seq UInt32,
  received_at DateTime64(3, 'UTC'),
  command String,
  output String,
  cwd String,
  served_by LowCardinality(String),   -- fast_path | llm | filter
  latency_ms UInt32,
  origin_label LowCardinality(String)  -- synthetic_fixture | live_demo
)
ENGINE = MergeTree
ORDER BY (session_id, seq, turn_id)
TTL toDateTime(received_at) + INTERVAL 7 DAY;
```

One `session_id` links the HTTP events (recon, exploit) and the shell turns, so the trap creates it at the first request from an IP and reuses it for the callback.

## C3. Fake host shape (`packages/shell/world.json`)

The keys are fixed now; B fills in the content.

```json
{
  "host": { "hostname": "acme-status-7f9c4", "user": "node", "uid": 1000,
            "os": "Alpine Linux v3.20", "uname": "Linux acme-status-7f9c4 6.1.0 ... x86_64" },
  "env":  { "NODE_ENV": "production", "PORT": "3000" },
  "dirs": { "/app": [".env.production", ".next", "node_modules", "package.json"] },
  "files": { "/app/.env.production": "DATABASE_URL=postgres://...@db.acme.invalid/acme\n" },
  "ps": "PID   USER     TIME  COMMAND\n    1 node      0:03 node server.js\n",
  "network": { "egress": "blocked", "dns": "fails" },
  "slow_commands": { "psql": 20000 }
}
```

## C4. Shared fixture (`tests/fixtures/demo-session.jsonl`)

About 15 shell turns in the C2 row format plus the matching HTTP events (one JSON object per line, with a `"kind": "event" | "turn"` field), all with `origin_label: "synthetic_fixture"`. It follows the attack in `llm-shell-demo.md` §1. C writes it at kickoff; D and E build against it before anything is live.

## Environment variables

| Name | Used by | Notes |
|---|---|---|
| `PORT` | A | default 3000 |
| `CONTROL_URL` | A | base URL for `/v1/shell/*` and `/v1/events/batch` |
| `INGEST_TOKEN` | A, control | write-only producer token |
| `CALLBACK_ALLOWLIST` | A | comma-separated IPs the reverse shell may connect to |
| `TRAP_INSTANCE_ID` | A | e.g. `demo-1` |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | C, D | never on the trap |
| `LLM_API_KEY`, `LLM_MODEL` | B | never on the trap |
| `GUILD_TRIGGER_KEY`, `GUILD_OWNER`, `GUILD_WORKSPACE` | E | never on the trap |
| `CONTROL_TOKEN` | D, E | operator login for the dashboard and `/v1/analyze` |
