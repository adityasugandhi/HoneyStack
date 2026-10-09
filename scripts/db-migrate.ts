// Workstream C — migration runner (clickhouse-plan.md §4.5).
// Applies sql/NNN-*.sql in order with the admin creds (no `database` option,
// since honeypot may not exist yet). Statements are idempotent, so no tracking
// table. Flags: --only 001,002  --dry-run.
// Usage: npm run db:migrate -- [--only 001,002] [--dry-run]
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@clickhouse/client';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? '').split(',').map((s) => s.trim())) : null;

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const files = readdirSync(dir)
  .filter((f) => /^\d{3}-.*\.sql$/.test(f))
  .sort()
  .filter((f) => !only || only.has(f.slice(0, 3)));

function statements(file: string): string[] {
  return readFileSync(path.join(dir, file), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n') // drop comment lines
    .split(';').map((s) => s.trim()).filter(Boolean);
}

if (dryRun) {
  for (const f of files) {
    console.log(`-- ${f}`);
    for (const s of statements(f)) console.log(s + ';\n');
  }
  process.exit(0);
}

const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_ADMIN_USER ?? process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_ADMIN_PASSWORD ?? process.env.CLICKHOUSE_PASSWORD,
  request_timeout: 15000
});

for (const f of files) {
  const stmts = statements(f);
  for (const query of stmts) await client.command({ query }); // HTTP interface: one statement per request
  console.log(`applied ${f} (${stmts.length} statements)`);
}
await client.close();
