import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import { setClientsForTest } from '../apps/control/clickhouse';
import { getTimeline, getServedByCounts, clickhouseEvidenceLoader } from '../apps/control/queries';
import { parseFixture } from '../scripts/load-fixture';

// Fake reader: records every call and answers by which table the SQL names.
const calls: { query: string; params: Record<string, unknown> }[] = [];
const EVENT = { event_id: 'e1', session_id: 's', received_at: '2026-10-09T18:00:00.000Z', method: 'GET', route: '/', payload_text: '', response_template: 'home-page' };
const TURN = { turn_id: 't1', session_id: 's', seq: '2', received_at: '2026-10-09T18:00:05.000Z', command: 'id', output: 'uid=1000', cwd: '/app', served_by: 'fast_path', latency_ms: '35' };
const fakeReader = {
  query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
    calls.push({ query, params: query_params ?? {} });
    const rows = /FROM honeypot\.events/.test(query) ? [EVENT]
      : /FROM honeypot\.shell_turns/.test(query) && /served_by, toUInt32/.test(query) ? [{ served_by: 'fast_path', n: '8' }, { served_by: 'llm', n: '6' }]
      : /FROM honeypot\.shell_turns/.test(query) ? [TURN]
      : [];
    return { json: async () => rows } as any;
  }
} as unknown as ClickHouseClient;

const SID = '00000000-0000-4000-8000-0000000000e1';
before(() => setClientsForTest({ reader: fakeReader }));
after(() => setClientsForTest(null));
beforeEach(() => { calls.length = 0; });

test('session id goes through query_params, never into the SQL string', async () => {
  await getTimeline(SID);
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    assert.ok(!c.query.includes(SID), 'SID must not be interpolated into SQL');
    assert.equal(c.params.session, SID);
  }
});

test('a non-UUID session id is rejected before any query', async () => {
  await assert.rejects(() => getTimeline("s' OR 1=1"));
  assert.equal(calls.length, 0);
});

test('getTimeline merges events + turns and orders by time', async () => {
  const items = await getTimeline(SID);
  assert.deepEqual(items.map((i) => i.kind), ['event', 'turn']);
  assert.ok(items[0].at <= items[1].at);
  assert.equal((items[1].data as any).seq, 2, 'UInt seq string became a number');
});

test('getServedByCounts turns UInt64 strings into numbers', async () => {
  assert.deepEqual(await getServedByCounts(SID), { fast_path: 8, llm: 6 });
});

test('clickhouseEvidenceLoader returns the Evidence shape guild.ts expects', async () => {
  const ev = await clickhouseEvidenceLoader(SID);
  assert.equal(ev.events[0].event_id, 'e1');
  assert.equal(ev.turns[0].turn_id, 't1');
  assert.equal(ev.turns[0].seq, 2);
});

test('parseFixture drops kind, splits rows, and --rebase-now keeps gaps', () => {
  const text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'demo-session.jsonl'), 'utf8');
  const plain = parseFixture(text);
  assert.ok(plain.events.length >= 3 && plain.turns.length >= 15);
  assert.ok(plain.events.every((e) => !('kind' in e)) && plain.turns.every((t) => !('kind' in (t as object))));

  const rebased = parseFixture(text, { rebaseTo: new Date('2030-01-01T00:00:00.000Z') });
  const gap = (rows: { received_at: string }[]) => Date.parse(rows[1].received_at) - Date.parse(rows[0].received_at);
  assert.equal(gap(rebased.events as any), gap(plain.events as any), 'rebase preserves inter-row gaps');
  assert.ok(Date.parse((rebased.turns.at(-1) as any).received_at) <= Date.parse('2030-01-01T00:00:00.000Z'));
});
