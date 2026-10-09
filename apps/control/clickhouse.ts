// Workstream C — ClickHouse client factory (clickhouse-plan.md §4.1).
// Two identities: an INSERT-only writer and a SELECT-only reader. Clients are
// lazy (never created at import time) so tests and dev runs without a database
// don't dial out. Tests swap in fakes via setClientsForTest().
import { createClient, type ClickHouseClient } from '@clickhouse/client';

const DATABASE = 'honeypot';

export function clickhouseConfigured(): boolean {
  return Boolean(process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_USER);
}

let writerClient: ClickHouseClient | null = null;
let readerClient: ClickHouseClient | null = null;
let fakes: { writer?: ClickHouseClient; reader?: ClickHouseClient } | null = null;

/** INSERT-only client (CLICKHOUSE_USER). best_effort lets ISO `…Z` strings land in DateTime64. */
export function writer(): ClickHouseClient {
  if (fakes?.writer) return fakes.writer;
  if (!writerClient) {
    writerClient = createClient({
      url: process.env.CLICKHOUSE_URL,
      username: process.env.CLICKHOUSE_USER,
      password: process.env.CLICKHOUSE_PASSWORD,
      database: DATABASE,
      request_timeout: 5000,
      clickhouse_settings: { date_time_input_format: 'best_effort' }
    });
  }
  return writerClient;
}

/**
 * SELECT-only client (CLICKHOUSE_READ_USER). Falls back to the writer creds
 * with a warning if the read vars are unset — acceptable for a local run only.
 * date_time_output_format:'iso' makes reads return `2026-10-09T18:05:11.000Z`;
 * without it ClickHouse returns a zone-less string that Date.parse treats as
 * local time, which would corrupt "time wasted" and the analyst evidence.
 */
export function reader(): ClickHouseClient {
  if (fakes?.reader) return fakes.reader;
  if (!readerClient) {
    const hasReadUser = Boolean(process.env.CLICKHOUSE_READ_USER);
    if (!hasReadUser) console.warn('[clickhouse] CLICKHOUSE_READ_USER unset; reader falls back to writer creds');
    readerClient = createClient({
      url: process.env.CLICKHOUSE_URL,
      username: hasReadUser ? process.env.CLICKHOUSE_READ_USER : process.env.CLICKHOUSE_USER,
      password: hasReadUser ? process.env.CLICKHOUSE_READ_PASSWORD : process.env.CLICKHOUSE_PASSWORD,
      database: DATABASE,
      request_timeout: 5000,
      clickhouse_settings: { date_time_output_format: 'iso' }
    });
  }
  return readerClient;
}

export function setClientsForTest(c: { writer?: ClickHouseClient; reader?: ClickHouseClient } | null): void {
  fakes = c;
}

export async function closeClickHouse(): Promise<void> {
  await Promise.all([writerClient?.close(), readerClient?.close()]);
  writerClient = null;
  readerClient = null;
}
