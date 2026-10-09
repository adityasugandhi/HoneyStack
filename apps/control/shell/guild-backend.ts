// Shell brain LLM backend that runs on Guild: one `honeystack-shell` session per attacker shell,
// one follow-up message per command the fast path can't answer. See agents/GUILD_SETUP.md.
import { guildFetch, isTransient, type GuildConfig } from '../guild';
import type { World } from './world';

const REPLY_TIMEOUT_MS = Number(process.env.GUILD_SHELL_TIMEOUT_MS || 60_000);

interface GuildShell {
  sessionId: string;
  sessionUrl: string;
  /** ID of the newest event we've seen; replies to the next command come after it. */
  cursor: string;
}

const shells = new Map<string, Promise<GuildShell>>();
/** Guild session IDs once known, so every turn of a shell session (fast path too) can carry one. */
const knownIds = new Map<string, string>();

export function knownGuildSessionId(shellSessionId: string): string {
  return knownIds.get(shellSessionId) ?? '';
}
/** Per-session queue: one Guild turn at a time, in order. */
const queues = new Map<string, Promise<unknown>>();

export function guildShellConfig(): GuildConfig {
  const owner = process.env.GUILD_OWNER;
  const workspace = process.env.GUILD_WORKSPACE;
  const keyPair = process.env.GUILD_SHELL_TRIGGER_KEY;
  if (!owner || !workspace || !keyPair) throw new Error('GUILD_OWNER, GUILD_WORKSPACE and GUILD_SHELL_TRIGGER_KEY must be set for SHELL_BACKEND=guild');
  return { owner, workspace, keyPair };
}

/** Wait for the agent's next reply after `afterId`. Returns the reply text and its event ID. */
async function nextReply(cfg: GuildConfig, sessionId: string, afterId: string | undefined): Promise<{ text: string; id: string }> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let delay = 400;
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, delay));
    delay = Math.min(delay * 1.4, 3000);
    const q = new URLSearchParams({ types: 'runtime_done,runtime_error', limit: '20', sort_by: 'id' });
    if (afterId) q.set('from_id', afterId);
    let events: any;
    try {
      events = await guildFetch(cfg, `/sessions/${sessionId}/events?${q}`);
    } catch (err) {
      if (isTransient(err)) continue;
      throw err;
    }
    for (const e of events.items ?? []) {
      if (e.type === 'runtime_error') throw new Error('honeystack-shell reported runtime_error');
      const text = typeof e.content === 'string' ? e.content : e.content?.text ?? e.content?.data;
      if (typeof text === 'string') return { text, id: e.id };
    }
  }
  throw new Error(`honeystack-shell did not reply within ${REPLY_TIMEOUT_MS / 1000}s`);
}

/** Start (once) the Guild session for an attacker shell and hand it the machine description. */
export function ensureGuildShell(shellSessionId: string, world: World): Promise<GuildShell> {
  let p = shells.get(shellSessionId);
  if (!p) {
    p = (async () => {
      const cfg = guildShellConfig();
      const route = `/workspaces/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.workspace)}/sessions`;
      const text = `<machine_description>\n${JSON.stringify(world)}\n</machine_description>`;
      const session = await guildFetch(cfg, route, {
        method: 'POST',
        body: JSON.stringify({ session_type: 'api_trigger', agent_input: { text } }),
      });
      const ready = await nextReply(cfg, session.id, undefined);
      knownIds.set(shellSessionId, session.id);
      console.log(`[shell-brain] Guild shell session ${session.session_url} (${ready.text.trim().slice(0, 20)})`);
      return { sessionId: session.id, sessionUrl: session.session_url, cursor: ready.id };
    })();
    p.catch(() => shells.delete(shellSessionId)); // let the next command retry
    shells.set(shellSessionId, p);
  }
  return p;
}

export interface GuildShellAnswer { text: string; guildSessionId: string; guildEventId: string }

/** Send one command (with its session_state block) and return the agent's raw reply. */
export function askGuildShell(shellSessionId: string, world: World, message: string): Promise<GuildShellAnswer> {
  const prev = queues.get(shellSessionId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const cfg = guildShellConfig();
    const shell = await ensureGuildShell(shellSessionId, world);
    const posted = await guildFetch(cfg, `/sessions/${shell.sessionId}/events`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'text', content: message }),
    });
    const reply = await nextReply(cfg, shell.sessionId, posted.id ?? shell.cursor);
    shell.cursor = reply.id;
    return { text: reply.text, guildSessionId: shell.sessionId, guildEventId: reply.id };
  });
  queues.set(shellSessionId, run);
  return run;
}

export async function guildShellUrl(shellSessionId: string): Promise<string | undefined> {
  return (await shells.get(shellSessionId)?.catch(() => undefined))?.sessionUrl;
}
