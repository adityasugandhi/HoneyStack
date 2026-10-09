// The control server (docs/contracts.md, "Process and file layout"). One process on :8080:
//   /v1/events/batch            -> workstream C's ingest handler (apps/control/ingest.mjs)
//   /v1/shell/*                 -> shell brain (B)
//   /v1/analyze, /v1/analysis/* -> Guild analyst (E)
// With CLICKHOUSE_URL set, shell turns and analyst evidence go through ClickHouse;
// without it, they use the local JSONL files (dev mode).
import { appendFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';
import { registerAnalysisRoutes, setEvidenceLoader, type EvidenceEvent, type EvidenceTurn } from './guild';
import { registerShellRoutes, setTurnSink } from './shell-brain';

// ingest.mjs builds its ClickHouse client at import time with `??` defaults, so an empty value
// from .env (CLICKHOUSE_URL=) must be removed rather than passed through as "".
for (const k of ['CLICKHOUSE_URL', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD']) if (!process.env[k]) delete process.env[k];
const useClickHouse = Boolean(process.env.CLICKHOUSE_URL);
const ingest = await import('./ingest.mjs');

if (useClickHouse) {
  setTurnSink((row) => ingest.insertShellTurn(row));
  setEvidenceLoader(async (sessionId) => {
    const [events, turns] = await Promise.all([ingest.getTimeline(sessionId), ingest.getTurns(sessionId)]);
    return {
      events: events.map((e) => ({ ...e, session_id: sessionId, received_at: isoUtc(e.received_at) }) as unknown as EvidenceEvent),
      turns: turns.map((t) => ({ ...t, session_id: sessionId, received_at: isoUtc(t.received_at) }) as unknown as EvidenceTurn),
    };
  });
}

/** ClickHouse returns `2026-10-09 18:00:00.000` (UTC, no zone) by default. */
function isoUtc(v: unknown): string {
  const s = String(v);
  return /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
}

// C's handler is a plain node request listener; route its one path to it, everything else to Fastify.
// Dev mode (no ClickHouse): HTTP events go to a local JSONL that the analyst's file loader also reads.
const LOCAL_EVENTS = process.env.HTTP_EVENTS_FILE || path.resolve('data/events.jsonl');
const insertLocal = async (rows: object[]) => {
  await mkdir(path.dirname(LOCAL_EVENTS), { recursive: true });
  await appendFile(LOCAL_EVENTS, rows.map((r) => JSON.stringify(r) + '\n').join(''));
};
const ingestServer = useClickHouse ? ingest.createIngestServer(process.env) : ingest.createIngestServer(process.env, { insert: insertLocal });
const ingestHandler = ingestServer.listeners('request')[0] as http.RequestListener;
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  serverFactory: (fastifyHandler) =>
    http.createServer((req, res) =>
      req.url?.split('?')[0] === '/v1/events/batch' ? ingestHandler(req, res) : fastifyHandler(req, res)),
});
registerShellRoutes(app);
registerAnalysisRoutes(app);
app.get('/health', async () => ({ ok: true, clickhouse: useClickHouse }));

await app.ready();
const port = Number(process.env.CONTROL_PORT || 8080);
await app.listen({ port, host: process.env.CONTROL_HOST || '127.0.0.1' });
