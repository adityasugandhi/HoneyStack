// Workstream C. Owns /v1/events/batch, the ClickHouse client, insertShellTurn(),
// and the saved queries D and E consume.
//
// No HTTP framework is chosen in contracts.md yet, so this matches the trap's
// plain-node factory style: createIngestServer(env) returns an http.Server.
// Swap it for the team's framework once one is picked.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { EventBatch, MAX_BATCH_BYTES, ShellTurn } from '../../packages/events/schema.ts';

const client = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
  database: 'honeypot',
  request_timeout: 5000
});

// ---- writers -------------------------------------------------------------

export async function insertEvents(rows) {
  await client.insert({
    table: 'events',
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' }
  });
}

// Called by B (shell brain) for each command/response pair.
export async function insertShellTurn(row) {
  const turn = ShellTurn.parse(row);
  await client.insert({
    table: 'shell_turns',
    values: [{ ...turn, received_at: turn.received_at ?? new Date().toISOString() }],
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' }
  });
}

// ---- saved queries (parameterized; never interpolate captured text) ------

export async function listSessions(limit = 100) {
  const rs = await client.query({
    query: `
      SELECT session_id,
             min(received_at) AS first_seen,
             max(received_at) AS last_seen,
             countIf(kind = 'event') AS http_events,
             countIf(kind = 'turn')  AS shell_turns
      FROM (
        SELECT session_id, received_at, 'event' AS kind FROM events
        UNION ALL
        SELECT session_id, received_at, 'turn'  AS kind FROM shell_turns
      )
      GROUP BY session_id
      ORDER BY last_seen DESC
      LIMIT {limit:UInt32}`,
    query_params: { limit },
    format: 'JSONEachRow'
  });
  return rs.json();
}

export async function getTimeline(sessionId, limit = 200) {
  const rs = await client.query({
    query: `
      SELECT event_id, received_at, method, route, planned_status,
             response_template, origin_label, payload_text
      FROM events
      WHERE session_id = {session:UUID}
      ORDER BY received_at, event_id
      LIMIT 1 BY event_id
      LIMIT {limit:UInt32}`,
    query_params: { session: sessionId, limit: Math.min(limit, 200) },
    format: 'JSONEachRow'
  });
  return rs.json();
}

export async function getTurns(sessionId, limit = 500) {
  const rs = await client.query({
    query: `
      SELECT turn_id, seq, received_at, command, output, cwd, served_by, latency_ms
      FROM shell_turns
      WHERE session_id = {session:UUID}
      ORDER BY seq, received_at
      LIMIT 1 BY turn_id
      LIMIT {limit:UInt32}`,
    query_params: { session: sessionId, limit },
    format: 'JSONEachRow'
  });
  return rs.json();
}

export async function getTimeWastedMs(sessionId) {
  const rs = await client.query({
    query: `
      SELECT toInt64(max(ts) - min(ts)) * 1000 AS ms FROM (
        SELECT received_at AS ts FROM events WHERE session_id = {session:UUID}
        UNION ALL
        SELECT received_at AS ts FROM shell_turns WHERE session_id = {session:UUID}
      )`,
    query_params: { session: sessionId },
    format: 'JSONEachRow'
  });
  const [row] = await rs.json();
  return Number(row?.ms ?? 0);
}

export async function countByServedBy(sessionId) {
  const rs = await client.query({
    query: `
      SELECT served_by, count() AS n
      FROM shell_turns
      WHERE session_id = {session:UUID}
      GROUP BY served_by
      ORDER BY n DESC`,
    query_params: { session: sessionId },
    format: 'JSONEachRow'
  });
  return rs.json();
}

export async function pingDatabase() {
  const rs = await client.query({ query: 'SELECT version() AS v', format: 'JSONEachRow' });
  const [row] = await rs.json();
  return row.v;
}

export function closeClient() {
  return client.close();
}

// ---- ingest server --------------------------------------------------------

function tokenOk(header, expected) {
  const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return expected.length > 0 && timingSafeEqual(a, b);
}

function readBoundedJson(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ error: 'too large' });
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ error: 'invalid json' });
      }
    });
    req.on('error', () => resolve({ error: 'read error' }));
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// `insert` is injectable so the route can be tested without a live database.
export function createIngestServer(env = process.env, { insert = insertEvents } = {}) {
  const ingestToken = env.INGEST_TOKEN ?? '';
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/events/batch') {
      return send(res, 404, { error: 'not found' });
    }
    if (!tokenOk(req.headers.authorization, ingestToken)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    const body = await readBoundedJson(req, MAX_BATCH_BYTES);
    if (body.error) return send(res, body.error === 'too large' ? 413 : 400, { error: body.error });

    const parsed = EventBatch.safeParse(body.value);
    if (!parsed.success) return send(res, 400, { error: 'invalid batch' });

    const receivedAt = new Date().toISOString();
    const rows = parsed.data.events.map((e) => ({ ...e, received_at: receivedAt, source: 'trap_http' }));
    try {
      await insert(rows);
    } catch {
      return send(res, 503, { error: 'insert failed' });
    }
    return send(res, 200, { accepted: rows.map((r) => r.event_id) });
  });
}
