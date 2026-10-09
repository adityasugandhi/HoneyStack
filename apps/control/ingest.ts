// Workstream C — ingest (clickhouse-plan.md §4.2).
// POST /v1/events/batch, plus the write sinks B and E plug into:
// insertShellTurn (B's turn sink) and insertAnalysis (E's analysis sink).
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clickhouseConfigured, writer } from './clickhouse';
import type { ShellTurnRow } from './shell-brain';
import type { AnalysisJob } from './guild';

export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 256 * 1024;
const MAX_PAYLOAD_TEXT = 16384;
const MAX_CMD = 16 * 1024;
const MAX_OUTPUT = 64 * 1024;
const LOCAL_EVENTS = () => process.env.HTTP_EVENTS_FILE || path.resolve('data/events.jsonl');
const guildColumnsOn = () => process.env.CLICKHOUSE_GUILD_COLUMNS === '1';

// §6 event, sender-controlled fields only. Unknown keys (e.g. a sender's
// origin_label) are stripped — the server owns the trusted fields.
export const IncomingEvent = z.object({
  event_id: z.string().uuid(),
  session_id: z.string().uuid(),
  observed_at: z.string().datetime(),
  trap_instance_id: z.string().min(1).max(64),
  method: z.string().min(1).max(16),
  route: z.string().min(1).max(512),
  payload_text: z.string().max(MAX_PAYLOAD_TEXT),
  payload_bytes: z.number().int().nonnegative(),
  response_template: z.string().max(64),
  planned_status: z.number().int().min(100).max(599)
});
export type IncomingEvent = z.infer<typeof IncomingEvent>;

export const EventBatch = z.object({
  events: z.array(IncomingEvent).min(1).max(MAX_BATCH_EVENTS)
}).strict();

export interface EventRow extends IncomingEvent {
  received_at: string;
  source: 'trap_http';
  origin_label: 'live_demo';
}

/** Inserts validated event rows; waits for the ack. Throws on failure. */
export async function insertEvents(rows: EventRow[]): Promise<void> {
  if (!clickhouseConfigured()) {
    await mkdir(path.dirname(LOCAL_EVENTS()), { recursive: true });
    await appendFile(LOCAL_EVENTS(), rows.map((r) => JSON.stringify(r) + '\n').join(''));
    return;
  }
  await writer().insert({ table: 'events', values: rows, format: 'JSONEachRow' });
}

/**
 * Turn sink for the shell brain: setTurnSink(insertShellTurn). Accepts B's
 * ShellTurnRow with or without the Guild fields. The Guild keys are only sent
 * once sql/003 is applied (CLICKHOUSE_GUILD_COLUMNS=1), else an insert would
 * fail with an unknown-column error.
 */
export async function insertShellTurn(row: ShellTurnRow): Promise<void> {
  const base = {
    turn_id: row.turn_id,
    session_id: row.session_id,
    seq: row.seq,
    received_at: row.received_at,
    command: row.command.slice(0, MAX_CMD),
    output: row.output.slice(0, MAX_OUTPUT),
    cwd: row.cwd,
    served_by: row.served_by,
    latency_ms: row.latency_ms,
    origin_label: row.origin_label
  };
  const value = guildColumnsOn()
    ? { ...base, guild_session_id: row.guild_session_id ?? '', guild_event_id: row.guild_event_id ?? '' }
    : base;
  await writer().insert({ table: 'shell_turns', values: [value], format: 'JSONEachRow' });
}

/**
 * Analysis sink for guild.ts: setAnalysisSink(insertAnalysis). One row per
 * state change; §2.5's ReplacingMergeTree keeps the latest per job. Needs
 * sql/004. result_json holds only the validated output, never the raw reply.
 */
export async function insertAnalysis(job: AnalysisJob): Promise<void> {
  if (!clickhouseConfigured()) return;
  const now = new Date().toISOString();
  await writer().insert({
    table: 'analyses',
    values: [{
      job_id: job.id,
      session_id: job.session_id,
      state: job.state,
      guild_session_id: job.guild_session_id ?? '',
      guild_session_url: job.guild_session_url ?? '',
      classification: job.result?.classification ?? '',
      result_json: job.result ? JSON.stringify(job.result) : '',
      error: job.error ?? '',
      time_wasted_seconds: job.time_wasted_seconds,
      evidence_count: job.evidence_count,
      created_at: job.started_at,
      finished_at: job.finished_at ?? null,
      updated_at: now
    }],
    format: 'JSONEachRow'
  });
}

function authorized(header: string | undefined): boolean {
  const token = process.env.INGEST_TOKEN ?? '';
  if (!token) return process.env.NODE_ENV !== 'production'; // same convention as shell-brain.ts
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

export function registerIngestRoutes(app: FastifyInstance): void {
  app.post('/v1/events/batch', { bodyLimit: MAX_BATCH_BYTES }, async (req, reply) => {
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = EventBatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid batch' });

    const received_at = new Date().toISOString();
    const rows: EventRow[] = parsed.data.events.map((e) => ({
      ...e,
      received_at,
      source: 'trap_http',
      origin_label: 'live_demo' // §6: the remote sender cannot establish trusted labels
    }));
    try {
      await insertEvents(rows);
    } catch (err) {
      req.log.error({ err }, 'event insert failed');
      return reply.code(503).send({ error: 'storage unavailable' });
    }
    return reply.code(200).send({ accepted: rows.map((r) => r.event_id) });
  });
}
