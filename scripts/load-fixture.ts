// Workstream C — fixture loader (clickhouse-plan.md §4.6).
// Loads tests/fixtures/demo-session.jsonl straight through the writer client,
// bypassing the HTTP route so labels aren't overwritten (keeps synthetic_fixture
// and the fixture's own received_at). Re-running only creates duplicate rows,
// which the reads dedupe. Usage: npm run db:load-fixture -- [--rebase-now]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writer } from '../apps/control/clickhouse';
import { insertShellTurn } from '../apps/control/ingest';
import type { ShellTurnRow } from '../apps/control/shell-brain';

export interface ParsedFixture { events: Record<string, unknown>[]; turns: ShellTurnRow[]; }

// Shifts every received_at/observed_at by one offset so the last row is `rebaseTo`
// (keeps the session inside the 7-day TTL and makes "time wasted" look current).
export function parseFixture(text: string, opts: { rebaseTo?: Date } = {}): ParsedFixture {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  let offset = 0;
  if (opts.rebaseTo) {
    const maxAt = Math.max(...rows.map((r) => Date.parse(r.received_at)));
    offset = opts.rebaseTo.getTime() - maxAt;
  }
  const shift = (iso: string) => new Date(Date.parse(iso) + offset).toISOString();
  const events: Record<string, unknown>[] = [];
  const turns: ShellTurnRow[] = [];
  for (const { kind, ...row } of rows) {
    if (offset && typeof row.received_at === 'string') row.received_at = shift(row.received_at);
    if (offset && typeof row.observed_at === 'string') row.observed_at = shift(row.observed_at);
    if (kind === 'event') events.push(row);
    else if (kind === 'turn') turns.push(row as ShellTurnRow);
  }
  return { events, turns };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'demo-session.jsonl');
  const rebase = process.argv.includes('--rebase-now');
  const { events, turns } = parseFixture(readFileSync(file, 'utf8'), rebase ? { rebaseTo: new Date() } : {});
  if (events.length) await writer().insert({ table: 'events', values: events, format: 'JSONEachRow' });
  for (const t of turns) await insertShellTurn(t);
  console.log(`loaded ${events.length} events + ${turns.length} turns`);
  console.log(`session: ${(events[0] as { session_id?: string })?.session_id ?? turns[0]?.session_id}`);
  console.log('re-running duplicates rows; reads dedupe by id.');
  const { closeClickHouse } = await import('../apps/control/clickhouse');
  await closeClickHouse();
}
