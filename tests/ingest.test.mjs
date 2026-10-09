import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventBatch, ShellTurn, StoredEvent } from '../packages/events/schema.ts';
import { createIngestServer } from '../apps/control/ingest.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(path.join(dir, 'fixtures', 'demo-session.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const events = rows.filter((r) => r.kind === 'event');
const turns = rows.filter((r) => r.kind === 'turn');
const stripKind = ({ kind, ...rest }) => rest;

test('fixture has HTTP events and 15 shell turns in one session', () => {
  assert.ok(events.length >= 3);
  assert.equal(turns.length, 15);
  assert.equal(new Set(rows.map((r) => r.session_id)).size, 1);
});

test('fixture event rows match StoredEvent; distinct IDs', () => {
  for (const e of events) StoredEvent.parse(stripKind(e));
  assert.equal(new Set(events.map((e) => e.event_id)).size, events.length);
});

test('fixture turn rows match ShellTurn; seq 0..n; valid served_by', () => {
  for (const t of turns) ShellTurn.parse(stripKind(t));
  assert.deepEqual(turns.map((t) => t.seq), [...Array(turns.length).keys()]);
  assert.ok(turns.every((t) => ['fast_path', 'llm', 'filter'].includes(t.served_by)));
});

test('EventBatch rejects >100 events and unknown fields', () => {
  const one = (() => { const { received_at, source, ...e } = stripKind(events[0]); return e; })();
  assert.equal(EventBatch.safeParse({ events: Array(101).fill(one) }).success, false);
  assert.equal(EventBatch.safeParse({ events: [{ ...one, rogue: 1 }] }).success, false);
  assert.equal(EventBatch.safeParse({ events: [] }).success, false);
});

// ---- ingest server (no live database; insert is injected) ----------------

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const batch = { events: events.map((e) => { const { received_at, source, ...rest } = stripKind(e); return rest; }) };

let server, base, lastInsert, insertBehavior;
const post = (payload, token = 'tok') => fetch(base + '/v1/events/batch', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload)
});

before(async () => {
  server = createIngestServer({ INGEST_TOKEN: 'tok' }, {
    insert: async (r) => { lastInsert = r; if (insertBehavior === 'throw') throw new Error('down'); }
  });
  base = `http://127.0.0.1:${await listen(server)}`;
});
after(() => server.close());

test('200: stamps received_at + source, returns accepted IDs', async () => {
  insertBehavior = 'ok';
  const res = await post(batch);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).accepted, batch.events.map((e) => e.event_id));
  assert.ok(lastInsert.every((r) => r.source === 'trap_http' && r.received_at));
});

test('401 on bad token, no insert', async () => {
  insertBehavior = 'ok';
  lastInsert = null;
  assert.equal((await post(batch, 'wrong')).status, 401);
  assert.equal(lastInsert, null);
});

test('400 on invalid body', async () => {
  assert.equal((await post({ events: [{ bad: 1 }] })).status, 400);
  assert.equal((await post('not json')).status, 400);
});

test('503 when the insert fails (no fake success)', async () => {
  insertBehavior = 'throw';
  assert.equal((await post(batch)).status, 503);
});
