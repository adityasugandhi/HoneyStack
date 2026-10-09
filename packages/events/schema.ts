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
