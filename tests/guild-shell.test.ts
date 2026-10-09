import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askGuildShell } from '../apps/control/shell/guild-backend';
import { loadWorld } from '../apps/control/shell/world';

test('Guild shell: opens with the machine description, then one follow-up per command', async () => {
  Object.assign(process.env, { GUILD_OWNER: 'o', GUILD_WORKSPACE: 'w', GUILD_SHELL_TRIGGER_KEY: 'k:s' });
  const posted: { url: string; body: any }[] = [];
  let replies = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'POST') posted.push({ url: u, body });
    let res: object;
    if (u.endsWith('/workspaces/o/w/sessions')) res = { id: 'g1', session_url: 'https://app.guild.ai/sessions/g1' };
    else if (init?.method === 'POST') res = { id: `msg-${posted.length}` };
    else {
      // Each poll returns the next reply after the cursor it was given.
      replies += 1;
      res = { items: [{ id: `reply-${replies}`, type: 'runtime_done', content: { text: replies === 1 ? 'READY' : 'node\n' } }] };
    }
    return new Response(JSON.stringify(res), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await askGuildShell('shell-1', loadWorld(), '<session_state>\ncwd: /app\n</session_state>\nwhoami');
    assert.equal(r.text, 'node\n');
    assert.equal(r.guildSessionId, 'g1');
    assert.equal(posted[0].body.session_type, 'api_trigger');
    assert.match(posted[0].body.agent_input.text, /^<machine_description>/);
    assert.equal(posted[1].url, 'https://api.guild.ai/v1/sessions/g1/events');
    assert.deepEqual(posted[1].body, { mode: 'text', content: '<session_state>\ncwd: /app\n</session_state>\nwhoami' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
