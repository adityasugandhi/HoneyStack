// Loads tests/fixtures/demo-session.jsonl into ClickHouse so D and E have data
// before anything is live. Run: npm run demo:seed
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StoredEvent } from '../packages/events/schema.ts';
import { insertEvents, insertShellTurn, closeClient } from '../apps/control/ingest.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'demo-session.jsonl');
const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const events = rows.filter((r) => r.kind === 'event').map(({ kind, ...e }) => StoredEvent.parse(e));
const turns = rows.filter((r) => r.kind === 'turn');

if (events.length) await insertEvents(events);
for (const { kind, ...t } of turns) await insertShellTurn(t);

console.log(`loaded ${events.length} events + ${turns.length} turns`);
console.log(`session: ${rows[0]?.session_id}`);
await closeClient();
