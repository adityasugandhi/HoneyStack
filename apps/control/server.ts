// The control server (docs/contracts.md "Process and file layout"; clickhouse-plan.md §4.4).
// One Fastify process on :8080:
//   /v1/events/batch            -> workstream C ingest (apps/control/ingest.ts)
//   /v1/shell/*                 -> shell brain (B)
//   /v1/analyze, /v1/analysis/* -> Guild analyst (E)
// With ClickHouse configured, shell turns, analyst evidence and analyses go through
// C's reader/writer. Without it (dev): turns -> B's local JSONL, evidence from the
// fixture, HTTP events -> data/events.jsonl (ingest.ts handles that fallback itself).
import Fastify from 'fastify';
import { clickhouseConfigured, closeClickHouse } from './clickhouse';
import { registerIngestRoutes, insertShellTurn, insertAnalysis } from './ingest';
import { clickhouseEvidenceLoader } from './queries';
import { registerShellRoutes, setTurnSink } from './shell-brain';
import { registerAnalysisRoutes, setEvidenceLoader, setAnalysisSink } from './guild';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

if (clickhouseConfigured()) {
  setTurnSink(insertShellTurn);
  setEvidenceLoader(clickhouseEvidenceLoader);
  setAnalysisSink(insertAnalysis);
} else {
  app.log.warn('ClickHouse not configured: turns -> local JSONL, evidence from fixture, events -> data/events.jsonl');
}

registerIngestRoutes(app); // C
registerShellRoutes(app); // B
registerAnalysisRoutes(app); // E
app.get('/health', async () => ({ ok: true, clickhouse: clickhouseConfigured() }));
app.addHook('onClose', async () => { await closeClickHouse(); });

const port = Number(process.env.CONTROL_PORT || 8080);
await app.listen({ port, host: process.env.CONTROL_HOST || '127.0.0.1' });
