// Live smoke test against a real ClickHouse service. Gated: skipped in `npm test`
// (which loads no .env). Run with:
//   npm run test:live
// It writes a few rows under a fresh random session (TTL cleans them up).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writer, reader, closeClickHouse } from '../apps/control/clickhouse';
import { insertEvents, insertShellTurn } from '../apps/control/ingest';
import { getTimeline, listSessions, getServedByCounts } from '../apps/control/queries';

const live = process.env.CLICKHOUSE_LIVE_TEST === '1';
const SESSION = randomUUID();
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

before(async () => {
  if (!live) return;
  await writer().insert({ table: 'events', format: 'JSONEachRow', values: [
    { event_id: randomUUID(), session_id: SESSION, observed_at: iso(0), received_at: iso(0), source: 'trap_http', trap_instance_id: 'live', method: 'GET', route: '/', payload_text: '', payload_bytes: 0, response_template: 'home-page', planned_status: 200, origin_label: 'synthetic_fixture' },
    { event_id: randomUUID(), session_id: SESSION, observed_at: iso(1000), received_at: iso(1000), source: 'trap_http', trap_instance_id: 'live', method: 'GET', route: '/api/env', payload_text: '', payload_bytes: 0, response_template: 'fake-env-values', planned_status: 200, origin_label: 'synthetic_fixture' }
  ] });
  for (let i = 0; i < 3; i++) {
    await insertShellTurn({ turn_id: randomUUID(), session_id: SESSION, seq: i, received_at: iso(2000 + i * 1000), command: `cmd${i}`, output: 'ok\n', cwd: '/app', served_by: i === 2 ? 'llm' : 'fast_path', latency_ms: 20, origin_label: 'synthetic_fixture', guild_session_id: '', guild_event_id: '' });
  }
});
after(async () => { if (live) await closeClickHouse(); });

test('ping both clients', { skip: !live }, async () => {
  assert.ok((await writer().ping()).success);
  assert.ok((await reader().ping()).success);
});

test('read back the session via queries', { skip: !live }, async () => {
  const timeline = await getTimeline(SESSION);
  assert.equal(timeline.filter((i) => i.kind === 'event').length, 2);
  assert.equal(timeline.filter((i) => i.kind === 'turn').length, 3);
  const counts = await getServedByCounts(SESSION);
  assert.equal(counts.fast_path, 2);
  assert.equal(counts.llm, 1);
  const mine = (await listSessions({ limit: 500 })).find((s) => s.session_id === SESSION);
  assert.ok(mine && mine.http_events === 2 && mine.commands === 3);
});

test('grants: reader cannot INSERT, writer cannot SELECT', { skip: !live || !process.env.CLICKHOUSE_READ_USER }, async () => {
  await assert.rejects(() => reader().insert({ table: 'events', values: [], format: 'JSONEachRow' }));
  await assert.rejects(() => writer().query({ query: 'SELECT 1' }));
});
