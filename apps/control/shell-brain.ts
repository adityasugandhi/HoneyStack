// Workstream B: the shell brain. Serves /v1/shell/* (docs/contracts.md, C1) and writes one
// shell_turns row per command (C2).
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { applySideEffects, tryFastPath } from './shell/fast-path';
import { ensureGuildShell, knownGuildSessionId } from './shell/guild-backend';
import { askShell, SHELL_BACKEND, type LlmTurn } from './shell/llm';
import { SessionStore, type ShellSession } from './shell/session';
import { displayPath, loadWorld, type World } from './shell/world';

export type ServedBy = 'fast_path' | 'llm' | 'guild' | 'filter';

/** Row shape of honeypot.shell_turns (docs/contracts.md, C2). */
export interface ShellTurnRow {
  turn_id: string;
  session_id: string;
  seq: number;
  received_at: string;
  command: string;
  output: string;
  cwd: string;
  served_by: ServedBy;
  latency_ms: number;
  origin_label: 'synthetic_fixture' | 'live_demo';
  /** Proposed C2 additions (pending team sign-off): empty when Guild wasn't involved. */
  guild_session_id: string;
  guild_event_id: string;
}

export interface ShellResponse {
  output: string;
  prompt: string;
  served_by: ServedBy;
  delay_ms: number;
  close: boolean;
}

const MAX_LLM_CALLS = Number(process.env.SHELL_MAX_LLM_CALLS || 200);
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Turn sink: where shell_turns rows go. Defaults to a local JSONL file until
// workstream C's insertShellTurn() exists; C plugs it in with setTurnSink().

type TurnSink = (row: ShellTurnRow) => Promise<void>;
const LOCAL_TURNS_FILE = process.env.SHELL_TURNS_FILE || path.resolve('data/shell_turns.jsonl');

const jsonlSink: TurnSink = async (row) => {
  await mkdir(path.dirname(LOCAL_TURNS_FILE), { recursive: true });
  await appendFile(LOCAL_TURNS_FILE, JSON.stringify(row) + '\n');
};

let turnSink: TurnSink = jsonlSink;
export function setTurnSink(sink: TurnSink) {
  turnSink = sink;
}

// ---------------------------------------------------------------------------
// Core logic (framework-free, so tests and the REPL can call it directly)

export class ShellBrain {
  readonly world: World;
  private sessions: SessionStore;
  private recent = new Map<string, LlmTurn[]>();

  constructor(world: World = loadWorld()) {
    this.world = world;
    this.sessions = new SessionStore(world);
  }

  prompt(s: ShellSession): string {
    return `${this.world.host.user}@${this.world.host.hostname}:${displayPath(this.world, s.cwd)}$ `;
  }

  open(sessionId: string, triggerEventId?: string, callback?: { ip: string; port: number }) {
    const s = this.sessions.getOrCreate(sessionId);
    s.triggerEventId = triggerEventId;
    s.callback = callback;
    // Start the Guild session now so it is warm by the first command the fast path can't answer.
    if (SHELL_BACKEND === 'guild') ensureGuildShell(sessionId, this.world).catch((err) => console.error('[shell-brain] Guild shell start failed:', err.message));
    return {
      banner: 'bash: cannot set terminal process group (1): Inappropriate ioctl for device\nbash: no job control in this shell\n',
      prompt: this.prompt(s),
    };
  }

  /** Run one command line. Throws LlmBudgetExceeded when the session is out of LLM calls. */
  async run(sessionId: string, command: string, opts: { origin?: ShellTurnRow['origin_label']; record?: boolean } = {}): Promise<ShellResponse> {
    const started = Date.now();
    const s = this.sessions.getOrCreate(sessionId);
    const line = command.replace(/\r?\n$/, '');
    const cwdBefore = s.cwd;
    if (line.trim()) s.history.push(line);
    s.seq += 1;
    const seq = s.seq;

    let output: string;
    let servedBy: ServedBy;
    let delayMs: number;
    let close = false;
    let guildSessionId = '';
    let guildEventId = '';

    const fast = tryFastPath(this.world, s, line);
    if (fast) {
      output = fast.output;
      servedBy = 'fast_path';
      close = fast.close;
      // Small jitter so instant answers don't look too instant.
      delayMs = fast.delayMs + 40 + Math.floor(Math.random() * 210);
    } else {
      const cacheKey = `${s.cwd}\0${line}`;
      const cached = s.llmCache.get(cacheKey);
      if (cached !== undefined) {
        output = cached;
        servedBy = SHELL_BACKEND === 'guild' ? 'guild' : 'llm';
        delayMs = 300 + Math.floor(Math.random() * 600); // a repeat should not come back instantly
      } else {
        if (s.llmCalls >= MAX_LLM_CALLS) throw new LlmBudgetExceeded();
        s.llmCalls += 1;
        const answer = await askShell(this.world, s, line, this.recent.get(sessionId) ?? []);
        output = answer.output;
        servedBy = answer.filtered ? 'filter' : answer.backend === 'guild' ? 'guild' : 'llm';
        guildSessionId = answer.guildSessionId ?? '';
        guildEventId = answer.guildEventId ?? '';
        if (!answer.filtered && isReadOnly(line)) s.llmCache.set(cacheKey, output);
        applySideEffects(this.world, s, line);
        delayMs = 0; // the model call itself was the delay
      }
    }

    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) output = output.slice(0, MAX_OUTPUT_BYTES);
    const recent = this.recent.get(sessionId) ?? [];
    recent.push({ command: line, output });
    this.recent.set(sessionId, recent.slice(-24));

    if (opts.record !== false) {
      const row: ShellTurnRow = {
        turn_id: randomUUID(),
        session_id: sessionId,
        seq,
        received_at: new Date(started).toISOString(),
        command: line,
        output,
        cwd: cwdBefore,
        served_by: servedBy,
        latency_ms: Date.now() - started,
        origin_label: opts.origin || 'live_demo',
        guild_session_id: guildSessionId || knownGuildSessionId(sessionId),
        guild_event_id: guildEventId,
      };
      turnSink(row).catch((err) => console.error('[shell-brain] failed to record turn:', err));
    }

    // No prompt after exit: the trap writes output + prompt, then hangs up.
    return { output, prompt: close ? '' : this.prompt(s), served_by: servedBy, delay_ms: delayMs, close };
  }
}

export class LlmBudgetExceeded extends Error {}

/** Commands whose output can be cached and replayed verbatim within a session. */
function isReadOnly(line: string): boolean {
  const first = line.trim().split(/\s+/)[0];
  return ['cat', 'ls', 'find', 'grep', 'head', 'tail', 'ps', 'netstat', 'ss', 'df', 'du', 'mount', 'ip', 'ifconfig', 'stat', 'file', 'wc', 'crontab', 'npm', 'node', 'lsof', 'free', 'uptime', 'w', 'who', 'last', 'dmesg'].includes(first);
}

// ---------------------------------------------------------------------------
// HTTP routes (C1)

const OpenBody = z.object({
  session_id: z.string().uuid(),
  trigger_event_id: z.string().uuid().optional(),
  callback_ip: z.string().max(64).optional(),
  callback_port: z.number().int().min(1).max(65535).optional(),
});
const CmdBody = z.object({
  session_id: z.string().uuid(),
  seq: z.number().int().min(0).optional(),
  command: z.string().max(MAX_COMMAND_BYTES),
});
const OneshotBody = z.object({
  session_id: z.string().uuid(),
  command: z.string().max(MAX_COMMAND_BYTES),
});

function authorized(req: FastifyRequest): boolean {
  const token = process.env.INGEST_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production'; // dev convenience; never in prod
  return req.headers.authorization === `Bearer ${token}`;
}

export function registerShellRoutes(app: FastifyInstance, brain = new ShellBrain()) {
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  };

  app.post('/v1/shell/open', { preHandler: guard }, async (req, reply) => {
    const body = OpenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const { session_id, trigger_event_id, callback_ip, callback_port } = body.data;
    const callback = callback_ip && callback_port ? { ip: callback_ip, port: callback_port } : undefined;
    return brain.open(session_id, trigger_event_id, callback);
  });

  app.post('/v1/shell/cmd', { preHandler: guard }, async (req, reply) => {
    const body = CmdBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    try {
      return await brain.run(body.data.session_id, body.data.command);
    } catch (err) {
      if (err instanceof LlmBudgetExceeded) return reply.code(429).send({ error: 'session limit reached' });
      throw err;
    }
  });

  app.post('/v1/shell/oneshot', { preHandler: guard }, async (req, reply) => {
    const body = OneshotBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    try {
      const r = await brain.run(body.data.session_id, body.data.command);
      return { output: r.output };
    } catch (err) {
      if (err instanceof LlmBudgetExceeded) return reply.code(429).send({ error: 'session limit reached' });
      throw err;
    }
  });

  return brain;
}
