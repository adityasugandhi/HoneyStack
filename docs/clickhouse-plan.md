# ClickHouse plan (workstream C)

**Implementer quick start:** point your coding agent at this file and say which track you're on (§5, Track 1 or Track 2). Read §2–§4 for the exact DDL, signatures, and rules, and raise anything in §7 with the team before applying 003/004.

Hand-off plan for two people, each with a coding agent. It turns [`workstreams/c-clickhouse.md`](workstreams/c-clickhouse.md) into concrete files, signatures, and checklists. It also folds in the Guild-backed shell brain.

Sources of truth: [`contracts.md`](contracts.md) (C2, env vars, file layout), `HoneyStack Implementation.txt` §6–§7, `apps/control/shell-brain.ts` (`ShellTurnRow`, `setTurnSink`), and `apps/control/guild.ts` (`Evidence*`, `setEvidenceLoader`).

> **Items marked [C2 CHANGE: needs team sign-off] change a frozen contract.** Don't apply them to the shared ClickHouse service until the team agrees. Everything else works without them.

---

## 1. Goal and "done"

**Goal:** every HTTP event and every shell turn lands in ClickHouse through the control server. The dashboard and the Guild analyst read them back with safe, parameterized queries.

**Done for the demo:**
- [ ] `npm run db:load-fixture` puts the fixture session (6 events + 18 turns) in ClickHouse, and the session-list query returns it with its time wasted.
- [ ] `npm run dev:control` + `npm run shell:repl`: each typed command shows up in `honeypot.shell_turns` within 1 s, with the right `served_by`.
- [ ] The trap's `POST /v1/events/batch` rows land in `honeypot.events` (`401` for a bad token, `400` for bad input, `503` when ClickHouse is down).
- [ ] `npm run analyze -- <live session id>` gives a validated Guild summary, built from ClickHouse rows rather than the JSONL fallback.
- [ ] The dashboard (D) refreshes from C's query functions every 5 s.

---

## 2. Schema

### 2.1 Dedupe decision: plain `MergeTree`, dedupe on read

- MergeTree doesn't enforce unique IDs. A trap retry (same `event_id`) or a re-run fixture load creates duplicate rows.
- **Choice:** keep `MergeTree` for `events` and `shell_turns`, as C2 says, and dedupe in every read:
  - row lists: `ORDER BY … LIMIT 1 BY event_id` / `LIMIT 1 BY turn_id`
  - counts: `uniqExact(event_id)` / `uniqExact(turn_id)`, never `count()`
- **Why not ReplacingMergeTree:** it only dedupes during background merges. Reads would still need `FINAL` or `LIMIT 1 BY` to be correct, so it adds nothing here and would change C2.
- **Exception:** `analyses` (§2.5) is a status row that gets updated. It uses `ReplacingMergeTree(updated_at)` so old states compact away, and reads still use `LIMIT 1 BY job_id`.

### 2.2 `sql/001-tables.sql` (unchanged from §7)

```sql
CREATE DATABASE IF NOT EXISTS honeypot;

CREATE TABLE IF NOT EXISTS honeypot.events
(
  event_id          UUID,
  session_id        UUID,
  observed_at       DateTime64(3, 'UTC'),
  received_at       DateTime64(3, 'UTC'),
  source            LowCardinality(String),   -- set by server: trap_http
  trap_instance_id  String,
  method            LowCardinality(String),
  route             String,
  payload_text      String,
  payload_bytes     UInt32,
  response_template String,
  planned_status    UInt16,
  origin_label      LowCardinality(String)    -- synthetic_fixture | live_demo
)
ENGINE = MergeTree
ORDER BY (session_id, received_at, event_id)
TTL toDateTime(received_at) + INTERVAL 7 DAY;
```

### 2.3 `sql/002-shell.sql` (C2 exactly as frozen)

```sql
CREATE TABLE IF NOT EXISTS honeypot.shell_turns
(
  turn_id      UUID,
  session_id   UUID,
  seq          UInt32,
  received_at  DateTime64(3, 'UTC'),
  command      String,
  output       String,
  cwd          String,
  served_by    LowCardinality(String),   -- fast_path | llm | filter  (+ guild, see 003)
  latency_ms   UInt32,
  origin_label LowCardinality(String)    -- synthetic_fixture | live_demo
)
ENGINE = MergeTree
ORDER BY (session_id, seq, turn_id)
TTL toDateTime(received_at) + INTERVAL 7 DAY;
```

### 2.4 `sql/003-shell-guild.sql`: **[C2 CHANGE: needs team sign-off]**

This is a separate migration, so 001/002 can ship now and 003 can follow after sign-off. `ADD COLUMN IF NOT EXISTS` makes it safe to re-run.

```sql
-- C2 change: link each shell turn to the Guild session that served the attacker's shell.
ALTER TABLE honeypot.shell_turns
  ADD COLUMN IF NOT EXISTS guild_session_id String DEFAULT '' AFTER served_by,
  ADD COLUMN IF NOT EXISTS guild_event_id   String DEFAULT '' AFTER guild_session_id;
-- served_by is LowCardinality(String): the new value 'guild' needs no DDL.
-- Allowed values become: fast_path | llm | guild | filter
```

Semantics (proposed):

| Column | Value |
|---|---|
| `guild_session_id` | The Guild session for this attacker shell session. Set on **every** turn once that Guild session exists, including `fast_path` turns, so one turn links the whole shell session. `''` when there is none. |
| `guild_event_id` | The Guild event that holds this command's reply. Only set when `served_by = 'guild'`, else `''`. |
| `served_by = 'guild'` | The command was answered by a follow-up message to the Guild shell agent. `llm` stays as the direct-LLM fallback. `filter` still means the output was replaced by the character filter. |

If 003 hasn't been applied yet, the final DDL of `shell_turns` is 002 plus these two `String DEFAULT ''` columns.

### 2.5 `sql/004-analyses.sql`: **[C2 CHANGE: needs team sign-off]** (recommended, not demo-critical)

**Recommendation:** persist analyses. Today `guild.ts` keeps jobs in an in-memory `Map`, so a control-server restart before the reveal loses the summary and its Guild URL. The table is cheap and append-only (the writer needs only `INSERT`). If the team says no, nothing else in this plan changes.

```sql
-- New table (C2 addition). One row per state change; latest row per job wins.
CREATE TABLE IF NOT EXISTS honeypot.analyses
(
  job_id              UUID,
  session_id          UUID,
  state               LowCardinality(String),   -- running | complete | failed
  guild_session_id    String,
  guild_session_url   String,
  classification      LowCardinality(String),   -- '' until complete; benign_test | suspicious_sequence | unknown
  result_json         String,                   -- validated AnalysisOutput as JSON; '' until complete
  error               String,
  time_wasted_seconds UInt32,
  evidence_count      UInt32,
  created_at          DateTime64(3, 'UTC'),
  finished_at         Nullable(DateTime64(3, 'UTC')),
  updated_at          DateTime64(3, 'UTC')      -- version column for ReplacingMergeTree
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (session_id, job_id)
TTL toDateTime(created_at) + INTERVAL 7 DAY;
```

`result_json` holds only the **validated** agent output, never the raw reply. This keeps §6's rule: "Guild output cannot overwrite events."

### 2.6 Notes

- TTL removal runs during background merges. It isn't an exact deadline (§7).
- **The fixture is dated 2026-10-09**, so the TTL drops it after about 2026-10-16. The fixture loader takes `--rebase-now` to shift its timestamps (§4.6).
- `received_at` is always set by the server, never trusted from the sender.

---

## 3. Access

### 3.1 Users and roles (`sql/users.sql.example`, placeholders only, never in `db:migrate`)

Run this once by hand in the ClickHouse Cloud SQL console as the admin (`default`) user. Real passwords go only in `.env`. Cloud requires passwords of 12+ characters with mixed case and digits or symbols.

```sql
-- Writer: the control server's insert path. INSERT only, no SELECT.
CREATE ROLE IF NOT EXISTS honeystack_writer_role;
GRANT INSERT ON honeypot.events      TO honeystack_writer_role;
GRANT INSERT ON honeypot.shell_turns TO honeystack_writer_role;
GRANT INSERT ON honeypot.analyses    TO honeystack_writer_role;   -- only if 004 is approved

-- Reader: dashboard queries + Guild evidence loader. SELECT only.
CREATE ROLE IF NOT EXISTS honeystack_reader_role;
GRANT SELECT ON honeypot.* TO honeystack_reader_role;

CREATE USER IF NOT EXISTS honeystack_writer IDENTIFIED WITH sha256_password BY '<writer password>';
CREATE USER IF NOT EXISTS honeystack_reader IDENTIFIED WITH sha256_password BY '<reader password>';
GRANT honeystack_writer_role TO honeystack_writer;
GRANT honeystack_reader_role TO honeystack_reader;
```

- `CREATE USER` defaults to `DEFAULT ROLE ALL`, so granted roles are active at login.
- **Don't set `readonly = 1`** on the reader. It blocks per-query settings, and the reader client sends `date_time_output_format = 'iso'` (§4.3). The `SELECT`-only grant is the real guard.
- Migrations run as the admin user from a laptop, never from the running control server.
- Cloud **IP access list**: add the control-server laptop's public IP (and the venue/hotspot IP) in the service settings, or every call times out.

### 3.2 Where credentials live

| Env var | Holder | Value |
|---|---|---|
| `CLICKHOUSE_URL` | control server (`.env`) | `https://<host>.clickhouse.cloud:8443` |
| `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | control server | `honeystack_writer` (contracts.md already lists these) |
| `CLICKHOUSE_READ_USER`, `CLICKHOUSE_READ_PASSWORD` | control server (dashboard + analyst run in-process) | `honeystack_reader`. **New env var names: add to contracts.md env table (sign-off)** |
| `CLICKHOUSE_ADMIN_USER`, `CLICKHOUSE_ADMIN_PASSWORD` | the migrating person's laptop only | `default`. Used only by `db:migrate`. **New names (sign-off)** |
| `INGEST_TOKEN` | trap + control server | producer token for `/v1/events/batch` and `/v1/shell/*` |

- **The trap never gets any `CLICKHOUSE_*` variable.** It holds only `INGEST_TOKEN`, which can't read rows or start analyses (§3).
- If the read vars are unset, `clickhouse.ts` falls back to the writer creds and logs a warning. That's acceptable for a local run, not for the demo.
- Add the new names (empty values) to `.env.example` in a separate small commit after sign-off. `.env` is already git-ignored.

---

## 4. Code tasks

### 4.0 File map (all owned by C)

| File | Track | Purpose |
|---|---|---|
| `sql/001-tables.sql`, `sql/002-shell.sql` | 1 | frozen schema |
| `sql/003-shell-guild.sql`, `sql/004-analyses.sql` | 1 | C2 changes, after sign-off |
| `sql/users.sql.example` | 1 | users and grants with placeholders |
| `scripts/db-migrate.ts` | 1 | applies `sql/0*.sql` in order |
| `apps/control/clickhouse.ts` | 1 (first commit) | client factory; shared by both tracks |
| `apps/control/ingest.ts` | 1 | `/v1/events/batch`, `insertShellTurn`, `insertAnalysis` |
| `apps/control/queries.ts` | 2 | read queries for D and E, `clickhouseEvidenceLoader` |
| `apps/control/server.ts` | 2 | real control server (replaces `scripts/dev-control.ts`) |
| `scripts/load-fixture.ts` | 2 | loads `tests/fixtures/demo-session.jsonl` |
| `tests/ingest.test.ts` | 1 | unit tests, no DB |
| `tests/queries.test.ts` | 2 | unit tests, no DB |
| `tests/clickhouse.live.test.ts` | 2 | live smoke test, gated |
| `package.json` scripts | both (separate small commits) | `dev:control`, `db:migrate`, `db:load-fixture`, `test:live` |

`queries.ts` and `clickhouse.ts` are new files under C's `apps/control/` area. They're split out of `ingest.ts` so the two people don't edit the same file.

Dependency: `npm install @clickhouse/client` (1.24.x at time of writing). One commit, `package.json` + lock only.

### 4.1 `apps/control/clickhouse.ts` (Track 1 commits this first, ~15 min; Track 2 codes against it)

The client API used here was checked against the official JS client docs: `createClient`, `insert({table, values, format: 'JSONEachRow'})`, `query({query, query_params, format})` → `resultSet.json<T>()`, `command({query})`, `ping()`, `close()`.

```ts
import { createClient, type ClickHouseClient } from '@clickhouse/client';

export function clickhouseConfigured(): boolean;           // true when CLICKHOUSE_URL + USER are set

/** INSERT-only client (CLICKHOUSE_USER). Lazy: created on first call, never at import time. */
export function writer(): ClickHouseClient;
/** SELECT-only client (CLICKHOUSE_READ_USER, falls back to the writer creds with a warning). */
export function reader(): ClickHouseClient;
/** Tests swap in fakes; pass null to reset. */
export function setClientsForTest(c: { writer?: ClickHouseClient; reader?: ClickHouseClient } | null): void;
export async function closeClickHouse(): Promise<void>;
```

Client options:
- `url: CLICKHOUSE_URL`, `username`, `password`, `database: 'honeypot'`, `request_timeout: 5000`
- writer: `clickhouse_settings: { date_time_input_format: 'best_effort' }`, which accepts ISO `…Z` strings into `DateTime64`
- reader: `clickhouse_settings: { date_time_output_format: 'iso' }`, which returns `2026-10-09T18:05:11.000Z`

**Why the reader setting matters:** without it ClickHouse returns `2026-10-09 18:05:11.000`. `Date.parse` reads that as *local* time, which would break `timeWastedSeconds()` and the analyst evidence in `guild.ts`.

Also: 64-bit integers (`uniqExact`, `count`, `dateDiff`) come back as **strings** in JSON. Cast them in SQL (`toUInt32(...)`) or wrap them with `Number()`.

### 4.2 `apps/control/ingest.ts` (Track 1)

```ts
import type { FastifyInstance } from 'fastify';
import type { ShellTurnRow } from './shell-brain';

export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 256 * 1024;

/** zod schema for one incoming §6 event. Sender-controlled fields only. */
export const IncomingEvent: z.ZodType<...>;
/** Request body: { events: IncomingEvent[] } (see Open question 3). */
export const EventBatch: z.ZodType<...>;

export interface EventRow { /* exact §7 column set */ }

/** Inserts validated rows; waits for the ack. Throws on failure. */
export async function insertEvents(rows: EventRow[]): Promise<void>;

/** Turn sink for the shell brain: setTurnSink(insertShellTurn). */
export async function insertShellTurn(row: ShellTurnRow): Promise<void>;

/** Analysis sink for guild.ts (if 004 is approved): one row per state change. */
export async function insertAnalysis(job: AnalysisJob): Promise<void>;

export function registerIngestRoutes(app: FastifyInstance): void;
```

**`POST /v1/events/batch`** (§7.2):

| Step | Rule |
|---|---|
| Auth | `Authorization: Bearer $INGEST_TOKEN`, compared with `crypto.timingSafeEqual` → else `401`. If `INGEST_TOKEN` is unset: allow only when `NODE_ENV !== 'production'` (same convention as `shell-brain.ts`). |
| Size | Route option `{ bodyLimit: MAX_BATCH_BYTES }`. Fastify rejects bigger bodies with `413` before the handler runs. |
| Validate | `EventBatch.safeParse` → `400` with no echo of the input. `events.length` must be 1–100. Per field: `event_id`, `session_id` UUID; `observed_at` ISO datetime; `method` ≤ 16 chars; `route` ≤ 512; `payload_text` ≤ 16384 (`BODY_LIMIT_BYTES`); `payload_bytes` int ≥ 0; `response_template` ≤ 64; `planned_status` 100–599; `trap_instance_id` ≤ 64. Unknown keys are stripped. |
| Server-owned fields | Overwrite `received_at = new Date().toISOString()`, `source = 'trap_http'`, `origin_label = 'live_demo'`. Any sender values are ignored (§6: "The remote sender cannot establish trusted labels"). |
| Insert | `await writer().insert({ table: 'events', values: rows, format: 'JSONEachRow' })`. Respond only after the ack. Any error → `503 { error: 'storage unavailable' }` and log it server-side. |
| Response | `200 { accepted: [event_id, …] }` |

**`insertShellTurn(row)`:**
- Normalize the row before inserting it: `guild_session_id ?? ''`, `guild_event_id ?? ''`. It accepts B's current `ShellTurnRow` (no Guild fields) and the future one.
- Until 003 is applied, the Guild keys must **not** be sent. Gate this on `process.env.CLICKHOUSE_GUILD_COLUMNS === '1'` (or drop the keys if the insert fails with an unknown-column error). Pick one; the env flag is simpler.
- Clamp `command` to 16 KiB and `output` to 64 KiB. These are the same limits B already enforces; this is a second guard.
- Single-row insert. At demo rates (<1/s) that's fine. Optionally add `clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 }`.
- Throw on failure. `shell-brain.ts` already `.catch`es and logs, so the attacker's shell never stalls on ClickHouse. Optional fallback: append the failed row to `data/shell_turns.unsent.jsonl` so it can be replayed with the fixture loader.

**`insertAnalysis(job)`:** maps `AnalysisJob` from `guild.ts` → §2.5 row, with `result_json = JSON.stringify(job.result ?? '')`, `classification = job.result?.classification ?? ''`, and `updated_at = now`.

### 4.3 `apps/control/queries.ts` (Track 2)

Rules:
- **Every value goes through `query_params` with `{name:Type}` placeholders. Attacker text never goes into the SQL string.**
- Validate `sessionId` as a UUID with zod before querying, so bad input never reaches ClickHouse.
- All reads go through `reader()`, use `format: 'JSONEachRow'`, and dedupe by ID.

```ts
export interface SessionSummary {
  session_id: string; started_at: string; last_seen_at: string;
  commands: number; http_events: number; time_wasted_seconds: number;
  origin_labels: string[]; guild_session_id: string;   // '' if none or 003 not applied
  live: boolean;                                        // computed in TS: last_seen_at within 120 s
}
export interface TimelineItem { kind: 'event' | 'turn'; id: string; at: string; seq?: number; data: EvidenceEvent | TurnRow }
export type TurnRow = EvidenceTurn & { latency_ms: number; origin_label: string; guild_session_id?: string; guild_event_id?: string };

export async function listSessions(opts?: { sinceHours?: number; limit?: number }): Promise<SessionSummary[]>;
export async function getSessionEvents(sessionId: string, limit?: number): Promise<EvidenceEvent[]>; // ORDER BY received_at
export async function getSessionTurns(sessionId: string, limit?: number): Promise<TurnRow[]>;        // ORDER BY seq
export async function getTimeline(sessionId: string): Promise<TimelineItem[]>;   // both lists in parallel, merged in TS by `at`
export async function getServedByCounts(sessionId?: string): Promise<Record<string, number>>;
export async function getLatestAnalysis(sessionId: string): Promise<AnalysisRow | null>;  // only if 004
export const clickhouseEvidenceLoader: EvidenceLoader;   // from guild.ts
```

Session list. Time wasted is `max − min` over events **and** turns, matching `timeWastedSeconds()` in `guild.ts`:

```sql
SELECT
  session_id,
  min(at)                                             AS started_at,
  max(at)                                             AS last_seen_at,
  toUInt32(uniqExactIf(id, kind = 'turn'))            AS commands,
  toUInt32(uniqExactIf(id, kind = 'event'))           AS http_events,
  toUInt32(dateDiff('second', min(at), max(at)))      AS time_wasted_seconds,
  groupUniqArray(origin_label)                        AS origin_labels,
  anyIf(guild_sid, guild_sid != '')                   AS guild_session_id
FROM
(
  SELECT session_id, event_id AS id, received_at AS at, 'event' AS kind,
         toString(origin_label) AS origin_label, '' AS guild_sid
  FROM honeypot.events
  WHERE received_at > now64(3) - toIntervalHour({since_hours:UInt32})
  UNION ALL
  SELECT session_id, turn_id, received_at, 'turn',
         toString(origin_label), guild_session_id          -- use '' here until 003 is applied
  FROM honeypot.shell_turns
  WHERE received_at > now64(3) - toIntervalHour({since_hours:UInt32})
)
GROUP BY session_id
ORDER BY last_seen_at DESC
LIMIT {limit:UInt32}
```

Turns for one session (events are the same shape, `ORDER BY received_at, event_id LIMIT 1 BY event_id`):

```sql
SELECT turn_id, session_id, seq, received_at, command, output, cwd,
       served_by, latency_ms, origin_label   -- , guild_session_id, guild_event_id  (after 003)
FROM honeypot.shell_turns
WHERE session_id = {session:UUID}
ORDER BY seq, received_at
LIMIT 1 BY turn_id
LIMIT {limit:UInt32}
```

`served_by` counts:

```sql
SELECT served_by, toUInt32(uniqExact(turn_id)) AS n
FROM honeypot.shell_turns
WHERE session_id = {session:UUID}      -- omit this line for the all-sessions variant
GROUP BY served_by
```

Latest analysis (if 004):

```sql
SELECT *
FROM
(
  SELECT * FROM honeypot.analyses
  WHERE session_id = {session:UUID}
  ORDER BY updated_at DESC
  LIMIT 1 BY job_id
)
ORDER BY created_at DESC
LIMIT 1
```

`clickhouseEvidenceLoader(sessionId)`:
- `Promise.all([getSessionEvents(id, 200), getSessionTurns(id, 500)])` → `{ events, turns }`.
- Fetch **more** than 20/40. `buildAgentInput()` slices to 20/40 itself and reports the omitted count from the full lengths.
- Keep only the `EvidenceEvent` / `EvidenceTurn` fields. Timestamps are ISO because of the reader setting in §4.1.

### 4.4 Wiring and `apps/control/server.ts` (Track 2)

```ts
// apps/control/server.ts: thin router (contracts.md "Process and file layout"). Port 8080.
import Fastify from 'fastify';
import { registerIngestRoutes, insertShellTurn /*, insertAnalysis */ } from './ingest';
import { clickhouseConfigured, closeClickHouse } from './clickhouse';
import { clickhouseEvidenceLoader } from './queries';
import { registerShellRoutes, setTurnSink } from './shell-brain';            // B
import { registerAnalysisRoutes, setEvidenceLoader } from './guild';        // E
import { registerDashboard } from '../dashboard/serve';                     // D

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

if (clickhouseConfigured()) {
  setTurnSink(insertShellTurn);
  setEvidenceLoader(clickhouseEvidenceLoader);
  // setAnalysisSink(insertAnalysis);   // needs E's hook; see hand-off H5
} else {
  app.log.warn('ClickHouse not configured: shell turns go to data/shell_turns.jsonl, evidence from the fixture');
}

registerIngestRoutes(app);
registerShellRoutes(app);
registerAnalysisRoutes(app);
registerDashboard(app);
app.get('/healthz', async () => ({ ok: true }));
app.addHook('onClose', closeClickHouse);

await app.listen({ port: Number(process.env.CONTROL_PORT || 8080), host: process.env.CONTROL_HOST || '127.0.0.1' });
```

- `package.json`: `"dev:control": "tsx --env-file-if-exists=.env apps/control/server.ts"`.
- **`apps/dashboard/serve.ts` belongs to D.** If D hasn't pushed it, ask D to push a stub that exports `registerDashboard(app) {}`. Don't create it yourself.
- After `server.ts` lands, tell B that `scripts/dev-control.ts` / `dev:shell` can point at it or be removed. That's B's call.

### 4.5 `scripts/db-migrate.ts` (Track 1)

- `package.json`: `"db:migrate": "tsx --env-file-if-exists=.env scripts/db-migrate.ts"`.
- Uses the admin creds (`CLICKHOUSE_ADMIN_USER`/`_PASSWORD`) with **no** `database` option, because `honeypot` may not exist yet.
- Reads `sql/[0-9][0-9][0-9]-*.sql` sorted by name, strips `--` comments, and splits on `;` at end of line. **The HTTP interface takes one statement per request.** Each statement runs via `client.command({ query })`.
- Every statement is idempotent (`IF NOT EXISTS`), so there's no migrations-tracking table. Re-running is safe.
- Flags: `--only 001,002` (use this before sign-off on 003/004) and `--dry-run`, which prints the statements without connecting.
- Never applies `users.sql.example`.

### 4.6 `scripts/load-fixture.ts` (Track 2)

- `package.json`: `"db:load-fixture": "tsx --env-file-if-exists=.env scripts/load-fixture.ts"`.
- Parses `tests/fixtures/demo-session.jsonl`, splits rows on `kind`, and **drops the `kind` key** (it isn't a column).
- Inserts with the **writer** client: events → `insertEvents`, turns → `insertShellTurn` (or one batch insert into `shell_turns`). Keep `origin_label: synthetic_fixture` and the fixture's own `received_at`. This bypasses the HTTP route, so labels aren't overwritten.
- `--rebase-now` shifts every timestamp by the same offset so the last row is "now" (keeps it inside the TTL and makes "time wasted" look current). IDs don't change.
- Idempotency: re-running only creates duplicates, which reads already dedupe. Print a note saying so.
- Export the pure parse/rebase function for unit tests: `export function parseFixture(text: string, opts?: { rebaseTo?: Date }): { events: EventRow[]; turns: ShellTurnRow[] }`.

### 4.7 Tests

**Unit, no DB (`npm test`; these must pass with no `.env`):**

| File | What |
|---|---|
| `tests/ingest.test.ts` | Through `app.inject()` with a fake writer from `setClientsForTest`: no token → 401; wrong token → 401; 101 events → 400; bad UUID / missing field → 400; body > 256 KiB → 413; insert throws → 503; success → 200 with `accepted` IDs, and the fake saw server-set `received_at`, `source='trap_http'`, `origin_label='live_demo'` even when the client sent other values. `insertShellTurn` fills `guild_*` with `''` only when `CLICKHOUSE_GUILD_COLUMNS=1`, and clamps long output. |
| `tests/queries.test.ts` | Fake reader records `{query, query_params}`: the session ID is in `query_params` and **not** in the query string; a non-UUID session ID is rejected before any call; `getTimeline` merges and orders events + turns; `clickhouseEvidenceLoader` returns the `Evidence` shape that `buildAgentInput()` accepts; `UInt64` strings become numbers; `parseFixture` drops `kind`, gives 6 + 18 rows, and `--rebase-now` keeps gaps. |

**Live smoke test (`tests/clickhouse.live.test.ts`):**
- Gated with `test('…', { skip: process.env.CLICKHOUSE_LIVE_TEST !== '1' }, …)`. It's skipped in `npm test` because that script loads no `.env`.
- `"test:live": "CLICKHOUSE_LIVE_TEST=1 tsx --env-file=.env --test tests/clickhouse.live.test.ts"`.
- Steps: `ping()` both clients → insert 2 events + 3 turns under a fresh random `session_id` with `origin_label='synthetic_fixture'` → read back via `getTimeline`, `listSessions`, `getServedByCounts` → assert counts and order. Also check that the reader's `INSERT` and the writer's `SELECT` are both **refused**, which proves the grants.
- It writes a few test rows to the real service, so run it deliberately. The TTL cleans them up.

---

## 5. Split for two people

| | **Track 1: DB + ingest** (person 1) | **Track 2: queries + wiring + fixture** (person 2) |
|---|---|---|
| Owns | `sql/*`, `scripts/db-migrate.ts`, `apps/control/clickhouse.ts`, `apps/control/ingest.ts`, `tests/ingest.test.ts` | `apps/control/queries.ts`, `apps/control/server.ts`, `scripts/load-fixture.ts`, `tests/queries.test.ts`, `tests/clickhouse.live.test.ts` |
| Talks to | A (trap batch shape), B (`insertShellTurn`, Guild columns), whoever holds the Cloud admin login | D (query functions), E (evidence loader, analysis sink), F (port 8080) |

### Hand-off points

| ID | From → To | What | When |
|---|---|---|---|
| H0 | Team → both | Sign-off on §2.4 (Guild columns), §2.5 (analyses), new env var names, batch body shape | ASAP; doesn't block 001/002 |
| H1 | T1 → T2 | `apps/control/clickhouse.ts` pushed with the exact signatures in §4.1 | first ~15 min |
| H2 | T1 → T2 | 001 + 002 applied to Cloud; writer + reader users exist; creds shared out-of-band into each `.env` | before T2's live work |
| H3 | T1 → B | `insertShellTurn` exported; it accepts rows with or without `guild_*` | checkpoint 2 |
| H4 | T2 → D, E | `queries.ts` functions + `clickhouseEvidenceLoader`, wired in `server.ts` | checkpoint 2 |
| H5 | T1 → E | `insertAnalysis(job)`. **Ask E** to add `setAnalysisSink(fn)` to `guild.ts`, called on job start and job finish | after 004 sign-off |
| H6 | B → T1 | B adds `guild_session_id?`, `guild_event_id?` to `ShellTurnRow` and `'guild'` to `ServedBy`; T1 then applies 003 and sets `CLICKHOUSE_GUILD_COLUMNS=1` | when B's Guild shell lands |
| H7 | T2 → F | Control server on `127.0.0.1:8080`; the tunnel exposes only `/v1/shell/*` + `/v1/events/batch` | checkpoint 3 |
| H8 | T2 → D | Ask D for the `registerDashboard` stub; tell D about the new `served_by = 'guild'` badge | early |

### Track 1 checklist (DB + ingest)

- [ ] `npm install @clickhouse/client` (own commit: `package.json` + lock).
- [ ] Write `apps/control/clickhouse.ts` (§4.1). Push it (**H1**).
- [ ] Write `sql/001-tables.sql`, `sql/002-shell.sql`, `sql/003-shell-guild.sql`, `sql/004-analyses.sql`, `sql/users.sql.example`.
- [ ] Write `scripts/db-migrate.ts` + the `db:migrate` script. Check it with `--dry-run`.
- [ ] In the Cloud console: IP access list; run the users/grants SQL with real passwords; put the creds in `.env`.
- [ ] `npm run db:migrate -- --only 001,002`. Check that the tables exist (**H2**).
- [ ] `ingest.ts`: `IncomingEvent`/`EventBatch` zod schemas, `insertEvents`, `registerIngestRoutes` (auth, bodyLimit, 400/401/413/503, server-owned fields).
- [ ] `ingest.ts`: `insertShellTurn` with Guild-field normalization behind `CLICKHOUSE_GUILD_COLUMNS` (**H3**).
- [ ] `tests/ingest.test.ts` green under `npm test`.
- [ ] After sign-off: apply 003 (**H6**) and 004, then write `insertAnalysis` (**H5**).
- [ ] Tell A the final batch body/response shape.

### Track 2 checklist (queries + wiring + fixture)

- [ ] Code against the §4.1 signatures with fake clients until **H1**.
- [ ] `queries.ts`: `listSessions`, `getSessionEvents`, `getSessionTurns`, `getTimeline`, `getServedByCounts`, `clickhouseEvidenceLoader`. Add the Guild columns to the selects behind the same `CLICKHOUSE_GUILD_COLUMNS` flag.
- [ ] `tests/queries.test.ts` green.
- [ ] `scripts/load-fixture.ts` + `parseFixture` + the `db:load-fixture` script.
- [ ] Ask D for the `registerDashboard` stub (**H8**). Write `apps/control/server.ts` + the `dev:control` script (own commit, since it's a shared file).
- [ ] After **H2**: `npm run db:load-fixture -- --rebase-now`; run the §6 queries; check the fixture session shows 6 events, 18 turns, and the right time wasted.
- [ ] `tests/clickhouse.live.test.ts` + `test:live`; run it once.
- [ ] Hand D and E the function list and return shapes (**H4**). Run `npm run analyze` against the fixture session through `server.ts`.
- [ ] Confirm port 8080 and the exposed routes with F (**H7**).
- [ ] After 004: `getLatestAnalysis` for D.

---

## 6. Verification

Run these from the repo root with `.env` filled in. `chq` is a throwaway shell helper for ad-hoc SQL through the reader user (HTTP interface):

```bash
chq() { curl -sS --user "$CLICKHOUSE_READ_USER:$CLICKHOUSE_READ_PASSWORD" "$CLICKHOUSE_URL/?database=honeypot" --data-binary "$1"; }
set -a; source .env; set +a
```

1. **Schema:** `npm run db:migrate -- --dry-run`, then (Track 1 only) `npm run db:migrate -- --only 001,002`.
   `chq "SELECT name, engine FROM system.tables WHERE database = 'honeypot' FORMAT PrettyCompact"`
2. **Grants:** `npm run test:live`. The writer can't SELECT and the reader can't INSERT.
3. **Fixture:** `npm run db:load-fixture -- --rebase-now`, then
   `chq "SELECT uniqExact(event_id) FROM events WHERE session_id = '5e55a1e0-7c3d-4b8e-9f21-6a0d3c9e4b17'"` → `6`
   `chq "SELECT uniqExact(turn_id), dateDiff('second', min(received_at), max(received_at)) FROM shell_turns WHERE session_id = '5e55a1e0-7c3d-4b8e-9f21-6a0d3c9e4b17'"` → `18`, plus a non-zero span
4. **Shell turns, live:** terminal 1 `npm run dev:control`; terminal 2 `npm run shell:repl`. Type `id`, `ls -la`, `cat /app/.env.production`, `netstat -tlnp`. Then
   `chq "SELECT seq, served_by, command, latency_ms FROM shell_turns ORDER BY received_at DESC LIMIT 5 FORMAT PrettyCompact"`.
   You should see a mix of `fast_path` and `llm` (or `guild`), and `guild_session_id` filled after 003 + B's change.
5. **Event ingest:**
   ```bash
   curl -sS -X POST localhost:8080/v1/events/batch -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
     -d '{"events":[{"event_id":"'$(uuidgen | tr A-Z a-z)'","session_id":"'$(uuidgen | tr A-Z a-z)'","observed_at":"2026-10-09T18:00:00.000Z","trap_instance_id":"demo-1","method":"GET","route":"/","payload_text":"","payload_bytes":0,"response_template":"home-page","planned_status":200}]}'
   # → 200 {"accepted":["…"]}; same call without the header → 401; "events":[] → 400
   ```
6. **Analyst from ClickHouse:** with `dev:control` running, `npm run analyze -- <session id from step 4>`. Expect `state: complete`, a `guild_session_url`, and evidence IDs that match `turn_id`s in `shell_turns`. Then `npm run analyze -- 5e55a1e0-7c3d-4b8e-9f21-6a0d3c9e4b17` for the fixture.
7. **Failure path:** set `CLICKHOUSE_URL` to a bad host and restart. Step 5 → `503`, and the REPL keeps answering (turn-insert errors are only logged).
8. **End to end (checkpoint 3/4):** run the full attack from `llm-shell-demo.md` §1 against the trap. `listSessions()` shows one session with HTTP events **and** turns under the same `session_id`.

---

## 7. Open questions for the team

1. **C2 change, Guild columns (§2.4):** OK to add `guild_session_id` / `guild_event_id` and `served_by = 'guild'`? Should `guild_session_id` be stamped on every turn of the shell session (proposed) or only on Guild-served turns? B must agree, since B writes the rows.
2. **C2 addition, `analyses` table (§2.5):** persist analyses (recommended), or keep them in memory? If yes, E needs to add `setAnalysisSink()` to `guild.ts`.
3. **Batch body shape:** §6 defines one event but not the batch envelope. Proposed: request `{ "events": [ … ] }`, response `{ "accepted": [event_id…] }`. A must match it.
4. **`origin_label` on ingest:** the server forces `live_demo` for everything arriving over `/v1/events/batch`, because the sender can't set trusted labels. Does A need to send fixture traffic through the route with a different label? (Proposed: no; fixtures go through `db:load-fixture`.)
5. **New env vars:** `CLICKHOUSE_READ_USER`/`_PASSWORD` (the dashboard runs in-process, so the control server holds both identities) and `CLICKHOUSE_ADMIN_USER`/`_PASSWORD` (laptop-only, migrations). OK to add them to the contracts.md env table?
6. **Oversized batches:** Fastify returns `413` for bodies over 256 KiB, while §7.2 lists only 400/401/503. Is `413` fine for A (proposed: yes; A treats any non-2xx as failed)?
