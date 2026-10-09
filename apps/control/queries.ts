// Workstream C — read queries for D (dashboard) and E (Guild evidence).
// (clickhouse-plan.md §4.3). Rules: reader() only; every value through
// query_params ({name:Type}); sessionId validated as UUID before any call;
// dedupe by ID (LIMIT 1 BY / uniqExact) because MergeTree keeps retry dupes.
import { z } from 'zod';
import { reader } from './clickhouse';
import type { Evidence, EvidenceEvent, EvidenceLoader, EvidenceTurn } from './guild';

const guildColumnsOn = () => process.env.CLICKHOUSE_GUILD_COLUMNS === '1';
const uuid = z.string().uuid();
function assertUuid(id: string): string {
  const r = uuid.safeParse(id);
  if (!r.success) throw new Error('session id must be a UUID');
  return id;
}

export interface SessionSummary {
  session_id: string;
  started_at: string;
  last_seen_at: string;
  commands: number;
  http_events: number;
  time_wasted_seconds: number;
  origin_labels: string[];
  guild_session_id: string;
  live: boolean;
}
export type TurnRow = EvidenceTurn & {
  latency_ms: number; origin_label: string; guild_session_id?: string; guild_event_id?: string;
};
export interface TimelineItem {
  kind: 'event' | 'turn'; id: string; at: string; seq?: number; data: EvidenceEvent | TurnRow;
}
export interface AnalysisRow {
  job_id: string; session_id: string; state: string; guild_session_id: string;
  guild_session_url: string; classification: string; result_json: string; error: string;
  time_wasted_seconds: number; evidence_count: number; created_at: string;
  finished_at: string | null; updated_at: string;
}

export async function listSessions(opts: { sinceHours?: number; limit?: number } = {}): Promise<SessionSummary[]> {
  const sinceHours = opts.sinceHours ?? 24;
  const limit = opts.limit ?? 100;
  const turnGuild = guildColumnsOn() ? 'guild_session_id' : `''`;
  const rs = await reader().query({
    query: `
      SELECT session_id,
             min(at)                                        AS started_at,
             max(at)                                        AS last_seen_at,
             toUInt32(uniqExactIf(id, kind = 'turn'))       AS commands,
             toUInt32(uniqExactIf(id, kind = 'event'))      AS http_events,
             toUInt32(dateDiff('second', min(at), max(at))) AS time_wasted_seconds,
             groupUniqArray(origin_label)                   AS origin_labels,
             anyIf(guild_sid, guild_sid != '')              AS guild_session_id
      FROM (
        SELECT session_id, event_id AS id, received_at AS at, 'event' AS kind,
               toString(origin_label) AS origin_label, '' AS guild_sid
        FROM honeypot.events
        WHERE received_at > now64(3) - toIntervalHour({since_hours:UInt32})
        UNION ALL
        SELECT session_id, turn_id, received_at, 'turn',
               toString(origin_label), ${turnGuild}
        FROM honeypot.shell_turns
        WHERE received_at > now64(3) - toIntervalHour({since_hours:UInt32})
      )
      GROUP BY session_id
      ORDER BY last_seen_at DESC
      LIMIT {limit:UInt32}`,
    query_params: { since_hours: sinceHours, limit },
    format: 'JSONEachRow'
  });
  const rows = await rs.json<Omit<SessionSummary, 'live'>>();
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    commands: Number(r.commands),
    http_events: Number(r.http_events),
    time_wasted_seconds: Number(r.time_wasted_seconds),
    guild_session_id: r.guild_session_id ?? '',
    live: now - Date.parse(r.last_seen_at) < 120_000
  }));
}

export async function getSessionEvents(sessionId: string, limit = 200): Promise<EvidenceEvent[]> {
  assertUuid(sessionId);
  const rs = await reader().query({
    query: `
      SELECT event_id, session_id, received_at, method, route, payload_text, response_template
      FROM honeypot.events
      WHERE session_id = {session:UUID}
      ORDER BY received_at, event_id
      LIMIT 1 BY event_id
      LIMIT {limit:UInt32}`,
    query_params: { session: sessionId, limit },
    format: 'JSONEachRow'
  });
  return rs.json<EvidenceEvent>();
}

export async function getSessionTurns(sessionId: string, limit = 500): Promise<TurnRow[]> {
  assertUuid(sessionId);
  const guildCols = guildColumnsOn() ? ', guild_session_id, guild_event_id' : '';
  const rs = await reader().query({
    query: `
      SELECT turn_id, session_id, seq, received_at, command, output, cwd,
             served_by, latency_ms, origin_label${guildCols}
      FROM honeypot.shell_turns
      WHERE session_id = {session:UUID}
      ORDER BY seq, received_at
      LIMIT 1 BY turn_id
      LIMIT {limit:UInt32}`,
    query_params: { session: sessionId, limit },
    format: 'JSONEachRow'
  });
  const rows = await rs.json<TurnRow>();
  return rows.map((t) => ({ ...t, seq: Number(t.seq), latency_ms: Number(t.latency_ms) }));
}

export async function getTimeline(sessionId: string): Promise<TimelineItem[]> {
  assertUuid(sessionId);
  const [events, turns] = await Promise.all([getSessionEvents(sessionId), getSessionTurns(sessionId)]);
  const items: TimelineItem[] = [
    ...events.map((e): TimelineItem => ({ kind: 'event', id: e.event_id, at: e.received_at, data: e })),
    ...turns.map((t): TimelineItem => ({ kind: 'turn', id: t.turn_id, at: t.received_at, seq: t.seq, data: t }))
  ];
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.seq ?? 0) - (b.seq ?? 0)));
}

export async function getServedByCounts(sessionId?: string): Promise<Record<string, number>> {
  const where = sessionId ? 'WHERE session_id = {session:UUID}' : '';
  const params: Record<string, unknown> = {};
  if (sessionId) params.session = assertUuid(sessionId);
  const rs = await reader().query({
    query: `SELECT served_by, toUInt32(uniqExact(turn_id)) AS n
            FROM honeypot.shell_turns ${where} GROUP BY served_by`,
    query_params: params,
    format: 'JSONEachRow'
  });
  const rows = await rs.json<{ served_by: string; n: string | number }>();
  return Object.fromEntries(rows.map((r) => [r.served_by, Number(r.n)]));
}

/** Only meaningful once sql/004 is applied; returns null if the table is absent. */
export async function getLatestAnalysis(sessionId: string): Promise<AnalysisRow | null> {
  assertUuid(sessionId);
  try {
    const rs = await reader().query({
      query: `
        SELECT * FROM (
          SELECT * FROM honeypot.analyses
          WHERE session_id = {session:UUID}
          ORDER BY updated_at DESC
          LIMIT 1 BY job_id
        )
        ORDER BY created_at DESC
        LIMIT 1`,
      query_params: { session: sessionId },
      format: 'JSONEachRow'
    });
    const [row] = await rs.json<AnalysisRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

// E plugs this into guild.ts via setEvidenceLoader(). Fetch more than the
// agent uses; buildAgentInput() slices to its own caps and reports the rest.
export const clickhouseEvidenceLoader: EvidenceLoader = async (sessionId: string): Promise<Evidence> => {
  assertUuid(sessionId);
  const [events, turns] = await Promise.all([getSessionEvents(sessionId, 200), getSessionTurns(sessionId, 500)]);
  return { events, turns };
};
