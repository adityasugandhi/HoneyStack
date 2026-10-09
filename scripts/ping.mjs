// Checks ClickHouse is reachable. Run: npm run db:ping
import { pingDatabase, closeClient } from '../apps/control/ingest.mjs';

const version = await pingDatabase();
console.log(`ClickHouse reachable, version ${version}`);
await closeClient();
