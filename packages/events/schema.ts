// Shared event contract (spec section 6). The trap sends everything except
// received_at and source; the ingest service assigns those.
import { z } from 'zod';

export const TrapEvent = z.object({
  event_id: z.string().uuid(),
  session_id: z.string().uuid(),
  observed_at: z.string().datetime(),
  trap_instance_id: z.string().min(1).max(64),
  method: z.string().max(16),
  route: z.string().max(256),
  payload_text: z.string().max(4096),
  payload_bytes: z.number().int().nonnegative(),
  response_template: z.string().max(64),
  planned_status: z.number().int().min(100).max(599),
  origin_label: z.literal('synthetic_fixture')
}).strict();

export const EventBatch = z.object({ events: z.array(TrapEvent).min(1).max(100) }).strict();
export type TrapEvent = z.infer<typeof TrapEvent>;

// ---------------------------------------------------------------------------
// Added by workstream C for the shell-turns plan (contracts.md §C2).
// SHARED, FROZEN FILE: per AGENTS.md, don't change the block above alone. The
// additions below are purely additive — TrapEvent/EventBatch are untouched, so
// the trap (A) is unaffected. Flag any change to these to the whole team.
// ---------------------------------------------------------------------------

export const MAX_BATCH_BYTES = 262144;
export const SERVED_BY = ['fast_path', 'llm', 'filter'] as const;

// What the control server stores after stamping receipt metadata.
export const StoredEvent = TrapEvent.extend({
  received_at: z.string().datetime(),
  source: z.literal('trap_http')
}).strict();
export type StoredEvent = z.infer<typeof StoredEvent>;

// One row per command typed into the fake shell. B writes these via
// insertShellTurn(); C stamps received_at if B omits it.
export const ShellTurn = z.object({
  turn_id: z.string().uuid(),
  session_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  received_at: z.string().datetime().optional(),
  command: z.string(),
  output: z.string(),
  cwd: z.string(),
  served_by: z.enum(SERVED_BY),
  latency_ms: z.number().int().nonnegative(),
  origin_label: z.enum(['synthetic_fixture', 'live_demo'])
}).strict();
export type ShellTurn = z.infer<typeof ShellTurn>;
