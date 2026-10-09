// Applies sql/*.sql in order. The first file creates the database, so this
// client is not bound to one. Run: npm run db:migrate
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@clickhouse/client';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: 10000
});

for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const statements = readFileSync(path.join(dir, file), 'utf8')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const query of statements) await client.command({ query });
  console.log(`applied ${file} (${statements.length} statements)`);
}
await client.close();
