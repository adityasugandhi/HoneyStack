import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAgentInput, fileEvidenceLoader, timeWastedSeconds, validateAgentOutput, waitForReply } from '../apps/control/guild';

// Works with whatever demo session workstream C keeps in the shared fixture.
const FIXTURE_ROWS = readFileSync('tests/fixtures/demo-session.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const FIXTURE_SESSION: string = FIXTURE_ROWS[0].session_id;
const fixtureCount = (kind: string) => FIXTURE_ROWS.filter((r) => r.session_id === FIXTURE_SESSION && r.kind === kind).length;

test('fixture evidence loads in order and spans time', async () => {
  const ev = await fileEvidenceLoader(FIXTURE_SESSION);
  assert.equal(ev.events.length, fixtureCount('event'));
  assert.equal(ev.turns.length, fixtureCount('turn'));
  const seqs = ev.turns.map((t) => t.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(timeWastedSeconds(ev) > 0);
});

test('agent input marks evidence untrusted and exposes every ID', async () => {
  const ev = await fileEvidenceLoader(FIXTURE_SESSION);
  const { text, ids } = buildAgentInput(FIXTURE_SESSION, ev);
  assert.equal(ids.size, Math.min(fixtureCount('event'), 20) + Math.min(fixtureCount('turn'), 40));
  assert.match(text, /untrusted attacker data/);
  assert.match(text, /<evidence>[\s\S]*<\/evidence>/);
  for (const id of ids) assert.ok(text.includes(id));
});

const good = (ids: string[]) => JSON.stringify({
  classification: 'suspicious_sequence',
  summary: 'Recon, then credential reads.',
  playbook_stages: [{ stage: 'recon', evidence_ids: [ids[0]] }, { stage: 'credential_hunting', evidence_ids: [ids[1]] }],
  evidence_event_ids: [ids[0]],
  credentials_targeted: ['DATABASE_URL'],
  limitations: ['Remote identity is unverified.'],
});

test('valid output passes, fenced output is unwrapped, cited IDs are completed', () => {
  const ids = ['a', 'b'];
  const r = validateAgentOutput('```json\n' + good(ids) + '\n```', new Set(ids));
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.evidence_event_ids.sort(), ['a', 'b']);
});

test('invented evidence IDs, unknown fields and bad labels fail', () => {
  assert.equal(validateAgentOutput(good(['a', 'zzz']), new Set(['a'])).ok, false);
  const extra = JSON.parse(good(['a', 'a']));
  extra.attacker_name = 'x';
  assert.equal(validateAgentOutput(JSON.stringify(extra), new Set(['a'])).ok, false);
  const bad = JSON.parse(good(['a', 'a']));
  bad.classification = 'definitely_evil';
  assert.equal(validateAgentOutput(JSON.stringify(bad), new Set(['a'])).ok, false);
  assert.equal(validateAgentOutput('Sure! Here is my analysis.', new Set(['a'])).ok, false);
});

test('waitForReply reads the runtime_done event', async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const body = String(url).includes('/events')
      ? { items: [{ type: 'runtime_done', content: { text: '{"ok":1}' } }], pagination: {} }
      : { root_task: { status: 'WAITING' } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const text = await waitForReply({ owner: 'o', workspace: 'w', keyPair: 'k:s' }, 'sess-1', 10_000);
    assert.equal(text, '{"ok":1}');
    assert.match(calls[0], /\/sessions\/sess-1\/events\?types=runtime_done/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
