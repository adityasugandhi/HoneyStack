import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTrap } from '../apps/trap/server.mjs';

const SID = '00000000-0000-4000-8000-000000000001';
let ingest, trap, base, received = [], ingestStatus = 200;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  ingest = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end(); }
      if (ingestStatus === 200) received.push(...JSON.parse(b).events);
      res.writeHead(ingestStatus); res.end('{}');
    });
  });
  const ip = await listen(ingest);
  trap = createTrap({
    DEMO_MODE: 'true', TRAP_INSTANCE_ID: 'test', INGEST_TOKEN: 'tok',
    INGEST_URL: `http://127.0.0.1:${ip}/v1/events/batch`, BODY_LIMIT_BYTES: '1024'
  });
  base = `http://127.0.0.1:${await listen(trap)}`;
});
after(() => { trap.close(); ingest.close(); });

const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'x-demo-session': SID, ...h }, body });

test('health works without capture', async () => {
  const before = received.length;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal(received.length, before);
});

test('three bait requests give three distinct events', async () => {
  received = [];
  await post('/api/login', '{"user":"a","password":"hunter2"}');
  await fetch(base + '/api/env', { headers: { 'x-demo-session': SID } });
  await post('/api/exec', '{"task":"demo-action"}');
  assert.equal(received.length, 3);
  assert.equal(new Set(received.map((e) => e.event_id)).size, 3);
  assert.ok(received.every((e) => e.session_id === SID && e.origin_label === 'synthetic_fixture'));
});

test('env route returns synthetic values only', async () => {
  process.env.DATABASE_URL = 'postgres://real:real@real/real';
  const t = await (await fetch(base + '/api/env')).text();
  assert.match(t, /db\.invalid/);
  assert.doesNotMatch(t, /real:real/);
  delete process.env.DATABASE_URL;
});

test('exec returns fixed text and does not run input', async () => {
  const r = await post('/api/exec', '{"task":"touch /tmp/honeystack-pwned"}');
  assert.equal(await r.text(), 'task completed');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync('/tmp/honeystack-pwned'), false);
});

test('passwords are redacted in stored payload', async () => {
  received = [];
  await post('/api/login', '{"user":"a","password":"hunter2"}');
  assert.doesNotMatch(received[0].payload_text, /hunter2/);
});

test('oversized body gets 413 with bounded metadata', async () => {
  received = [];
  const r = await post('/api/exec', 'x'.repeat(5000));
  assert.equal(r.status, 413);
  assert.equal(received[0].payload_bytes, 1024);
  assert.equal(received[0].planned_status, 413);
});

test('ingest failure gives explicit 503, not fake success', async () => {
  ingestStatus = 503;
  const r = await post('/api/exec', '{"task":"demo-action"}');
  ingestStatus = 200;
  assert.equal(r.status, 503);
});

test('unknown path and wrong method get controlled 404', async () => {
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/api/exec')).status, 404);
});
