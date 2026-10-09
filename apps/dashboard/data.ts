import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickhouseConfigured } from '../control/clickhouse';
import { getLatestAnalysis, getTimeline, listSessions, type AnalysisRow, type SessionSummary, type TimelineItem } from '../control/queries';
import { getAnalysis, type AnalysisJob } from '../control/guild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(root, 'tests/fixtures/demo-session.jsonl');
const noiseRoutes = new Set(['/health', '/favicon.ico', '/robots.txt']);
const baitTemplates = new Set(['fake-env-values', 'fake-env', 'fake-admin-token']);
const baitRoutes = new Set(['/api/env', '/api/login']);
const stageNames = ['Noise', 'Recon', 'Token leak', 'Injection', 'Reverse shell', 'Post-exploitation'] as const;
const currentJobs = new Map<string, string>();

export function trackAnalysisJob(sessionId: string, jobId: string): void {
  currentJobs.set(sessionId, jobId);
}

export interface Stage { level: number; label: string }
export interface DashboardSession extends SessionSummary {
  stage: Stage;
  analysis_state: string | null;
  bait_reads: number;
  fixture: boolean;
}
export interface DashboardAnalysis {
  id: string;
  state: string;
  guild_session_url?: string;
  time_wasted_seconds: number;
  result?: AnalysisJob['result'];
  error?: string;
}

export function stageFromTimeline(timeline: TimelineItem[]): Stage {
  const turns = timeline.filter((item) => item.kind === 'turn');
  let level = turns.length >= 3 ? 5 : turns.length ? 4 : 0;
  for (const item of timeline) {
    if (item.kind !== 'event') continue;
    const event = item.data as { route: string; response_template: string };
    if (!noiseRoutes.has(event.route)) level = Math.max(level, 1);
    if (baitRoutes.has(event.route) || baitTemplates.has(event.response_template)) level = Math.max(level, 2);
    if (event.response_template === 'diag-injected') level = Math.max(level, 3);
    if (event.response_template === 'revshell-callback') level = Math.max(level, 4);
  }
  return { level, label: stageNames[level] };
}

function jsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

function fileRows(): Record<string, unknown>[] {
  const turns = process.env.SHELL_TURNS_FILE || path.join(root, 'data/shell_turns.jsonl');
  const events = process.env.HTTP_EVENTS_FILE || path.join(root, 'data/events.jsonl');
  return [
    ...jsonl(fixturePath),
    ...jsonl(turns).map((row) => ({ ...row, kind: 'turn' })),
    ...jsonl(events).map((row) => ({ ...row, kind: 'event' })),
  ];
}

function fileTimelines(): Map<string, TimelineItem[]> {
  const groups = new Map<string, Map<string, TimelineItem>>();
  for (const row of fileRows()) {
    if (row.kind !== 'event' && row.kind !== 'turn') continue;
    const sessionId = String(row.session_id || '');
    const id = String(row.kind === 'turn' ? row.turn_id : row.event_id);
    const at = String(row.received_at || '');
    if (!sessionId || !id || !at) continue;
    if (!groups.has(sessionId)) groups.set(sessionId, new Map());
    groups.get(sessionId)!.set(id, {
      kind: row.kind,
      id,
      at,
      ...(row.kind === 'turn' ? { seq: Number(row.seq || 0) } : {}),
      data: row as unknown as TimelineItem['data'],
    } as TimelineItem);
  }
  return new Map([...groups].map(([id, rows]) => [id, [...rows.values()].sort((a, b) =>
    a.at.localeCompare(b.at) || (a.kind === b.kind ? (a.seq ?? 0) - (b.seq ?? 0) : a.kind === 'event' ? -1 : 1))]));
}

/** True when the attacker's last shell command was `exit`/`logout`: the shell is closed. */
export function endedByExit(timeline: TimelineItem[]): boolean {
  const last = timeline.filter((item) => item.kind === 'turn').at(-1);
  return Boolean(last && /^(exit|logout)\s*$/i.test(String((last.data as { command: string }).command)));
}

function fileSummary(sessionId: string, timeline: TimelineItem[]): SessionSummary {
  const first = timeline[0]?.at || new Date().toISOString();
  const last = timeline.at(-1)?.at || first;
  const turns = timeline.filter((item) => item.kind === 'turn');
  const labels = [...new Set(timeline.map((item) => String((item.data as { origin_label?: string }).origin_label || 'live_demo')))];
  const ended = turns.at(-1)?.kind === 'turn' && /^(exit|logout)\s*$/i.test(String((turns.at(-1)!.data as { command: string }).command));
  return {
    session_id: sessionId,
    started_at: first,
    last_seen_at: last,
    commands: turns.length,
    http_events: timeline.length - turns.length,
    time_wasted_seconds: Math.max(0, Math.round((Date.parse(last) - Date.parse(first)) / 1000)),
    origin_labels: labels,
    guild_session_id: '',
    live: !labels.includes('synthetic_fixture') && !ended && Date.now() - Date.parse(last) < 120_000,
  };
}

function baitReadCount(timeline: TimelineItem[]): number {
  return timeline.filter((item) => item.kind === 'turn' && /(?:\.env|credentials|notes\.txt|sudo\s+-l)/i.test(
    String((item.data as { command: string }).command))).length;
}

function parseSavedAnalysis(row: AnalysisRow | null): DashboardAnalysis | null {
  if (!row) return null;
  let result: AnalysisJob['result'];
  try { result = JSON.parse(row.result_json) as AnalysisJob['result']; } catch { /* still show state */ }
  return {
    id: row.job_id,
    state: row.state,
    guild_session_url: row.guild_session_url,
    time_wasted_seconds: Number(row.time_wasted_seconds || 0),
    result,
    error: row.error,
  };
}

export async function analysisForSession(sessionId: string, jobId?: string): Promise<DashboardAnalysis | null> {
  const currentJobId = jobId ?? currentJobs.get(sessionId);
  if (currentJobId) {
    const job = getAnalysis(currentJobId);
    if (job && job.session_id === sessionId) return {
      id: job.id, state: job.state, guild_session_url: job.guild_session_url,
      time_wasted_seconds: job.time_wasted_seconds, result: job.result, error: job.error,
    };
  }
  return clickhouseConfigured() ? parseSavedAnalysis(await getLatestAnalysis(sessionId)) : null;
}

export async function dashboardSessions(sinceHours = 24, limit = 60): Promise<DashboardSession[]> {
  if (!clickhouseConfigured()) {
    const groups = fileTimelines();
    return [...groups].map(([sessionId, timeline]) => {
      const summary = fileSummary(sessionId, timeline);
      return { ...summary, stage: stageFromTimeline(timeline), analysis_state: getAnalysis(currentJobs.get(sessionId) || '')?.state ?? null,
        bait_reads: baitReadCount(timeline), fixture: summary.origin_labels.includes('synthetic_fixture') };
    }).filter((session) => session.fixture || Date.parse(session.last_seen_at) >= Date.now() - sinceHours * 3600_000)
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at)).slice(0, limit);
  }
  const summaries = await listSessions({ sinceHours, limit });
  return Promise.all(summaries.map(async (summary) => {
    const [timeline, saved] = await Promise.all([getTimeline(summary.session_id), getLatestAnalysis(summary.session_id)]);
    return { ...summary, live: summary.live && !endedByExit(timeline), stage: stageFromTimeline(timeline), analysis_state: getAnalysis(currentJobs.get(summary.session_id) || '')?.state ?? saved?.state ?? null,
      bait_reads: baitReadCount(timeline), fixture: summary.origin_labels.includes('synthetic_fixture') };
  }));
}

export async function dashboardSession(sessionId: string): Promise<{ summary: DashboardSession; timeline: TimelineItem[]; analysis: DashboardAnalysis | null } | null> {
  const timeline = clickhouseConfigured() ? await getTimeline(sessionId) : fileTimelines().get(sessionId) ?? [];
  if (!timeline.length) return null;
  const summary = clickhouseConfigured()
    ? (await listSessions({ sinceHours: 24 * 7, limit: 500 })).find((row) => row.session_id === sessionId) ?? fileSummary(sessionId, timeline)
    : fileSummary(sessionId, timeline);
  const analysis = await analysisForSession(sessionId);
  return { summary: { ...summary, live: summary.live && !endedByExit(timeline), stage: stageFromTimeline(timeline), analysis_state: analysis?.state ?? null,
    bait_reads: baitReadCount(timeline), fixture: summary.origin_labels.includes('synthetic_fixture') }, timeline, analysis };
}

export async function dashboardOverview(sinceHours = 24) {
  const sessions = await dashboardSessions(sinceHours);
  return {
    attackers_trapped: sessions.filter((session) => session.stage.level >= 3).length,
    commands_captured: sessions.reduce((total, session) => total + session.commands, 0),
    time_wasted_seconds: sessions.reduce((total, session) => total + session.time_wasted_seconds, 0),
    bait_reads: sessions.reduce((total, session) => total + session.bait_reads, 0),
    analyses_completed: sessions.filter((session) => session.analysis_state === 'complete').length,
    sessions_total: sessions.length,
    source: clickhouseConfigured() ? 'clickhouse' : 'local',
  };
}
