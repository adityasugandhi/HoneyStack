// Integration test: real ClickHouse round-trip through the ingest module's
// writers and saved queries. Skipped unless CLICKHOUSE_URL is set, so
// `npm test` stays green with no database. Uses a throwaway session id and
// deletes those rows before and after, so it never collides with demo data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { ShellTurn, StoredEvent } from '../packages/events/schema.ts';
import {
  countByServedBy, getTimeWastedMs, getTimeline, getTurns,
  insertEvents, insertShellTurn, listSessions, pingDatabase, closeClient
} from '../apps/control/ingest.mjs';

const live = Boolean(process.env.CLICKHOUSE_URL);
const SESSION = randomUUID();
const dir = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(dir, 'fixtures', 'demo-session.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const events = raw.filter((r) => r.kind === 'event')
  .map(({ kind, ...e }) => StoredEvent.parse({ ...e, session_id: SESSION }));
const turns = raw.filter((r) => r.kind === 'turn')
  .map(({ kind, ...t }) => ShellTurn.parse({ ...t, session_id: SESSION }));

const admin = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? ''
});

async function migrate() {
  for (const file of ['001-tables.sql', '002-shell.sql']) {
    const sql = readFileSync(path.join(dir, '..', 'sql', file), 'utf8');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await admin.command({ query: stmt });
    }
  }
}

async function deleteSession() {
  for (const table of ['events', 'shell_turns']) {
    await admin.command({
      query: `ALTER TABLE honeypot.${table} DELETE WHERE session_id = {s:UUID}`,
      query_params: { s: SESSION },
      clickhouse_settings: { mutations_sync: '2' }
    });
  }
}

before(async () => {
  if (!live) return;
  await migrate();
  await deleteSession();
  await insertEvents(events);
  for (const t of turns) await insertShellTurn(t);
});

after(async () => {
  if (!live) return;
  await deleteSession();
  await admin.close();
  await closeClient();
});

test('reaches ClickHouse', { skip: !live }, async () => {
  assert.match(await pingDatabase(), /^\d+\./);
});

test('getTimeline returns every stored HTTP event, ordered', { skip: !live }, async () => {
  const got = await getTimeline(SESSION);
  assert.equal(got.length, events.length);
  assert.deepEqual(got.map((r) => r.route), events.map((e) => e.route));
});

test('getTurns returns all shell turns in seq order', { skip: !live }, async () => {
  const got = await getTurns(SESSION);
  assert.equal(got.length, turns.length);
  assert.deepEqual(got.map((r) => Number(r.seq)), [...Array(turns.length).keys()]);
  assert.equal(got.at(-1).command, 'exit');
});

test('countByServedBy aggregates the fixture turns', { skip: !live }, async () => {
  const got = await countByServedBy(SESSION);
  const map = Object.fromEntries(got.map((r) => [r.served_by, Number(r.n)]));
  assert.deepEqual(map, { fast_path: 8, llm: 6, filter: 1 });
});

test('getTimeWastedMs spans the session (~124 s)', { skip: !live }, async () => {
  const ms = await getTimeWastedMs(SESSION);
  assert.ok(ms >= 120000 && ms <= 130000, `time wasted was ${ms} ms`);
});

test('listSessions includes the session with both counts', { skip: !live }, async () => {
  const mine = (await listSessions(500)).find((r) => r.session_id === SESSION);
  assert.ok(mine, 'session not listed');
  assert.equal(Number(mine.http_events), events.length);
  assert.equal(Number(mine.shell_turns), turns.length);
});
