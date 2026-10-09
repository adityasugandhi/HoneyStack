import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ClickHouseClient } from '@clickhouse/client';
import { setClientsForTest } from '../apps/control/clickhouse';
import { registerIngestRoutes, insertShellTurn } from '../apps/control/ingest';

// Fake writer: records inserts; can be told to throw for the 503 path.
const inserts: { table: string; values: any[] }[] = [];
let throwOnInsert = false;
const fakeWriter = {
  insert: async ({ table, values }: { table: string; values: any[] }) => {
    if (throwOnInsert) throw new Error('clickhouse down');
    inserts.push({ table, values });
    return {} as any;
  }
} as unknown as ClickHouseClient;

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtureEvents = readFileSync(path.join(dir, 'fixtures', 'demo-session.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'event');
// Build sender-shaped events (route strips received_at/source; sender sets synthetic_fixture).
const batch = {
  events: fixtureEvents.map(({ kind, received_at, source, origin_label, ...e }) => ({ ...e, origin_label: 'synthetic_fixture' }))
};

let app: FastifyInstance;
before(async () => {
  process.env.CLICKHOUSE_URL = 'http://fake';   // make clickhouseConfigured() true so the fake writer is used
  process.env.CLICKHOUSE_USER = 'u';
  process.env.INGEST_TOKEN = 'tok';
  delete process.env.CLICKHOUSE_GUILD_COLUMNS;
  setClientsForTest({ writer: fakeWriter });
  app = Fastify();
  registerIngestRoutes(app);
  await app.ready();
});
beforeEach(() => { inserts.length = 0; throwOnInsert = false; });
after(async () => { await app.close(); setClientsForTest(null); });

const post = (payload: unknown, token = 'tok') => app.inject({
  method: 'POST', url: '/v1/events/batch',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
});

test('no / wrong token -> 401, no insert', async () => {
  const noTok = await app.inject({ method: 'POST', url: '/v1/events/batch', payload: JSON.stringify(batch), headers: { 'content-type': 'application/json' } });
  assert.equal(noTok.statusCode, 401);
  assert.equal((await post(batch, 'wrong')).statusCode, 401);
  assert.equal(inserts.length, 0);
});

test('101 events / bad uuid / missing field -> 400', async () => {
  const one = batch.events[0];
  assert.equal((await post({ events: Array(101).fill(one) })).statusCode, 400);
  assert.equal((await post({ events: [{ ...one, event_id: 'not-a-uuid' }] })).statusCode, 400);
  const { planned_status, ...missing } = one;
  assert.equal((await post({ events: [missing] })).statusCode, 400);
});

test('body over 256 KiB -> 413', async () => {
  const res = await post('{"events":[' + '"x",'.repeat(70000) + '"x"]}');
  assert.equal(res.statusCode, 413);
});

test('insert throws -> 503', async () => {
  throwOnInsert = true;
  assert.equal((await post(batch)).statusCode, 503);
});

test('success -> 200 + server owns received_at/source/origin_label', async () => {
  const res = await post(batch);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().accepted, batch.events.map((e) => e.event_id));
  const rows = inserts.find((i) => i.table === 'events')!.values;
  assert.ok(rows.every((r: any) => r.source === 'trap_http' && r.received_at && r.origin_label === 'live_demo'),
    'server forces source/received_at/origin_label even though sender sent synthetic_fixture');
});

test('insertShellTurn omits guild cols unless CLICKHOUSE_GUILD_COLUMNS=1, and clamps output', async () => {
  const row: any = {
    turn_id: '00000000-0000-4000-8000-0000000000a1', session_id: '00000000-0000-4000-8000-0000000000a2',
    seq: 0, received_at: new Date().toISOString(), command: 'id', output: 'x'.repeat(100_000),
    cwd: '/app', served_by: 'fast_path', latency_ms: 10, origin_label: 'live_demo'
  };
  await insertShellTurn(row);
  let v = inserts.find((i) => i.table === 'shell_turns')!.values[0];
  assert.ok(!('guild_session_id' in v), 'guild cols omitted by default');
  assert.ok(v.output.length <= 64 * 1024, 'output clamped to 64 KiB');

  inserts.length = 0;
  process.env.CLICKHOUSE_GUILD_COLUMNS = '1';
  await insertShellTurn({ ...row, guild_session_id: 'g1', guild_event_id: '' });
  v = inserts.find((i) => i.table === 'shell_turns')!.values[0];
  assert.equal(v.guild_session_id, 'g1');
  delete process.env.CLICKHOUSE_GUILD_COLUMNS;
});
