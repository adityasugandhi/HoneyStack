import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import { dashboardOverview, dashboardSession, dashboardSessions, stageFromTimeline } from '../apps/dashboard/data';
import { registerDashboard } from '../apps/dashboard/serve';
import type { TimelineItem } from '../apps/control/queries';

const fixtureId = 'bc702acb-031a-4723-bfa7-5c3365b31324';
const event = (route: string, response_template: string): TimelineItem => ({
  kind: 'event', id: `${route}:${response_template}`, at: '2026-10-09T18:00:00.000Z',
  data: { event_id: 'a', session_id: fixtureId, received_at: '2026-10-09T18:00:00.000Z',
    method: 'GET', route, payload_text: '', response_template },
});
const turn = (seq: number): TimelineItem => ({
  kind: 'turn', id: `turn-${seq}`, at: '2026-10-09T18:00:00.000Z', seq,
  data: { turn_id: `turn-${seq}`, session_id: fixtureId, seq, received_at: '2026-10-09T18:00:00.000Z',
    command: 'id', output: 'node', cwd: '/app', served_by: 'fast_path', latency_ms: 1, origin_label: 'synthetic_fixture' },
});

test('stage rules track the real trap response templates', () => {
  assert.equal(stageFromTimeline([event('/health', 'health')]).level, 0);
  assert.equal(stageFromTimeline([event('/', 'home-page')]).level, 1);
  assert.equal(stageFromTimeline([event('/api/env', 'fake-env-values')]).level, 2);
  assert.equal(stageFromTimeline([event('/api/admin/diagnostics', 'diag-injected')]).level, 3);
  assert.equal(stageFromTimeline([event('/api/admin/diagnostics', 'revshell-callback')]).level, 4);
  assert.equal(stageFromTimeline([turn(0), turn(1), turn(2)]).level, 5);
});

test('file adapter groups fixture evidence and produces overview numbers', async () => {
  const sessions = await dashboardSessions();
  const fixture = sessions.find((session) => session.session_id === fixtureId);
  assert.ok(fixture);
  assert.equal(fixture.stage.level, 5);
  assert.equal(fixture.commands, 18);
  assert.equal(fixture.fixture, true);
  assert.equal(fixture.live, false);
  const detail = await dashboardSession(fixtureId);
  assert.ok(detail);
  assert.equal(detail.timeline.length, 24);
  assert.equal(detail.timeline[0].kind, 'event');
  const overview = await dashboardOverview();
  assert.ok(overview.attackers_trapped >= 1);
  assert.ok(overview.bait_reads >= 2);
});

test('file adapter picks up new local attacks without ClickHouse', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'honeystack-dashboard-'));
  const oldEvents = process.env.HTTP_EVENTS_FILE;
  const oldTurns = process.env.SHELL_TURNS_FILE;
  const sessionId = '10000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  writeFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({
    event_id: '10000000-0000-4000-8000-000000000002', session_id: sessionId, received_at: now,
    method: 'POST', route: '/api/admin/diagnostics', payload_text: '{"host":"x; id"}',
    response_template: 'diag-injected', origin_label: 'live_demo',
  }) + '\n');
  writeFileSync(path.join(directory, 'turns.jsonl'), JSON.stringify({
    turn_id: '10000000-0000-4000-8000-000000000003', session_id: sessionId, received_at: now,
    seq: 0, command: 'id', output: 'uid=1000(node)', cwd: '/app', served_by: 'fast_path', origin_label: 'live_demo',
  }) + '\n');
  process.env.HTTP_EVENTS_FILE = path.join(directory, 'events.jsonl');
  process.env.SHELL_TURNS_FILE = path.join(directory, 'turns.jsonl');
  try {
    const session = (await dashboardSessions()).find((item) => item.session_id === sessionId);
    assert.ok(session);
    assert.equal(session.stage.level, 4);
    assert.equal(session.commands, 1);
    assert.equal(session.live, true);
    assert.equal(session.fixture, false);
    const detail = await dashboardSession(sessionId);
    assert.deepEqual(detail?.timeline.map((item) => item.kind), ['event', 'turn']);
  } finally {
    if (oldEvents === undefined) delete process.env.HTTP_EVENTS_FILE; else process.env.HTTP_EVENTS_FILE = oldEvents;
    if (oldTurns === undefined) delete process.env.SHELL_TURNS_FILE; else process.env.SHELL_TURNS_FILE = oldTurns;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('admin API requires operator login and blocks tunnel requests', async () => {
  const previous = { token: process.env.CONTROL_TOKEN, nodeEnv: process.env.NODE_ENV, allowRemote: process.env.ADMIN_ALLOW_REMOTE };
  process.env.CONTROL_TOKEN = 'test-operator-secret';
  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_ALLOW_REMOTE;
  const app = Fastify();
  registerDashboard(app);
  try {
    await app.ready();
    const denied = await app.inject({ method: 'GET', url: '/admin/api/sessions' });
    assert.equal(denied.statusCode, 401);
    const page = await app.inject({ method: 'GET', url: '/admin/plugins/honeystack' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /HoneyStack Shield/);
    const badLogin = await app.inject({ method: 'POST', url: '/admin/login', payload: { token: 'wrong' } });
    assert.equal(badLogin.statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { token: 'test-operator-secret' } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict; Path=\/admin/);
    const allowed = await app.inject({ method: 'GET', url: '/admin/api/sessions', headers: { cookie } });
    assert.equal(allowed.statusCode, 200);
    assert.ok(JSON.parse(allowed.body).sessions.length > 0);
    const bearer = await app.inject({ method: 'GET', url: '/admin/api/overview', headers: { authorization: 'Bearer test-operator-secret' } });
    assert.equal(bearer.statusCode, 200);
    const tunneled = await app.inject({ method: 'GET', url: '/admin/plugins/honeystack', headers: { 'cf-connecting-ip': '203.0.113.2' } });
    assert.equal(tunneled.statusCode, 404);
    const tunneledApi = await app.inject({ method: 'GET', url: '/admin/api/sessions', headers: { cookie, 'cf-connecting-ip': '203.0.113.2' } });
    assert.equal(tunneledApi.statusCode, 404);
  } finally {
    await app.close();
    if (previous.token === undefined) delete process.env.CONTROL_TOKEN; else process.env.CONTROL_TOKEN = previous.token;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.allowRemote === undefined) delete process.env.ADMIN_ALLOW_REMOTE; else process.env.ADMIN_ALLOW_REMOTE = previous.allowRemote;
  }
});

test('captured text is inserted as text, never parsed as markup', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/dashboard/public/app.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(source, /textContent/);
  assert.match(source, /hostname === 'app\.guild\.ai'/);
});

test('a session whose last command was exit is not live, and replay links point at the shell agent', async () => {
  const { endedByExit } = await import('../apps/dashboard/data');
  const turn = (seq: number, command: string) => ({ kind: 'turn' as const, id: `t${seq}`, at: `2026-10-09T18:00:0${seq}.000Z`, seq, data: { command } as never });
  assert.equal(endedByExit([turn(1, 'id'), turn(2, 'exit')]), true);
  assert.equal(endedByExit([turn(1, 'exit'), turn(2, 'id')]), false);
  assert.equal(endedByExit([]), false);
  const app = readFileSync(new URL('../apps/dashboard/public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /acme-status/);
  assert.match(app, /app\.guild\.ai\/sessions\/\$\{encodeURIComponent\(data\.guild_session_id\)\}/);
});
