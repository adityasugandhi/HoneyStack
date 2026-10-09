import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAnalysis, NoEvidence, startAnalysis } from '../control/guild';
import { analysisForSession, dashboardOverview, dashboardSession, dashboardSessions, trackAnalysisJob } from './data';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const cookieName = 'hs_admin';
const uuid = z.string().uuid();
const jobSessions = new Map<string, string>();

function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function sessionCookieValue(token: string): string {
  return createHmac('sha256', token).update('honeystack-dashboard-session-v1').digest('hex');
}

function cookieValue(req: FastifyRequest): string | null {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='));
  return cookie ? cookie.slice(cookieName.length + 1) : null;
}

function authorized(req: FastifyRequest): boolean {
  const token = process.env.CONTROL_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production';
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const cookie = cookieValue(req);
  return Boolean((bearer && equalSecret(bearer, token)) || (cookie && equalSecret(cookie, sessionCookieValue(token))));
}

async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  if (!authorized(req)) return reply.code(401).send({ error: 'Operator sign-in required' });
}

function sinceHours(value: unknown): number {
  const parsed = Number(value ?? 24);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(168, Math.round(parsed))) : 24;
}

function noCache(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
}

export function registerDashboard(app: FastifyInstance): void {
  void app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      if (req.headers['cf-connecting-ip'] && process.env.ADMIN_ALLOW_REMOTE !== '1') {
        return reply.code(404).send({ error: 'Not found' });
      }
      noCache(reply);
    });

    admin.get('/plugins/honeystack', async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      return readFile(path.join(publicDir, 'index.html'));
    });

    admin.get('/assets/:file', async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (file !== 'app.js' && file !== 'dashboard.css') return reply.code(404).send({ error: 'Not found' });
      reply.type(file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      return readFile(path.join(publicDir, file));
    });

    admin.post('/login', async (req, reply) => {
      const body = z.object({ token: z.string().max(4096) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Enter the operator token' });
      const token = process.env.CONTROL_TOKEN;
      if (!token && process.env.NODE_ENV === 'production') return reply.code(503).send({ error: 'Operator access is not configured' });
      if (token && !equalSecret(body.data.token, token)) return reply.code(401).send({ error: 'Invalid operator token' });
      const value = token ? sessionCookieValue(token) : 'dev';
      const secure = req.protocol === 'https' ? '; Secure' : '';
      reply.header('Set-Cookie', `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=86400${secure}`);
      return { ok: true };
    });

    admin.post('/logout', { preHandler: requireOperator }, async (_req, reply) => {
      reply.header('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
      return { ok: true };
    });

    admin.get('/api/overview', { preHandler: requireOperator }, async (req) => {
      const query = req.query as { since?: string };
      return dashboardOverview(sinceHours(query.since));
    });

    admin.get('/api/sessions', { preHandler: requireOperator }, async (req) => {
      const query = req.query as { since?: string };
      return { sessions: await dashboardSessions(sinceHours(query.since)) };
    });

    admin.get('/api/sessions/:id', { preHandler: requireOperator }, async (req, reply) => {
      const id = uuid.safeParse((req.params as { id: string }).id);
      if (!id.success) return reply.code(400).send({ error: 'Invalid session ID' });
      const detail = await dashboardSession(id.data);
      if (!detail) return reply.code(404).send({ error: 'Session not found' });
      return detail;
    });

    admin.post('/api/sessions/:id/analyze', { preHandler: requireOperator }, async (req, reply) => {
      const id = uuid.safeParse((req.params as { id: string }).id);
      if (!id.success) return reply.code(400).send({ error: 'Invalid session ID' });
      try {
        const job = await startAnalysis(id.data);
        jobSessions.set(job.id, id.data);
        trackAnalysisJob(id.data, job.id);
        return reply.code(202).send({ job_id: job.id, guild_session_url: job.guild_session_url });
      } catch (error) {
        if (error instanceof NoEvidence) return reply.code(404).send({ error: 'No evidence for this session' });
        req.log.error(error);
        return reply.code(502).send({ error: error instanceof Error ? error.message : 'Analysis could not start' });
      }
    });

    admin.get('/api/analysis/:jobId', { preHandler: requireOperator }, async (req, reply) => {
      const id = uuid.safeParse((req.params as { jobId: string }).jobId);
      if (!id.success) return reply.code(400).send({ error: 'Invalid analysis ID' });
      const job = getAnalysis(id.data);
      if (job) return job;
      const sessionId = jobSessions.get(id.data);
      const saved = sessionId ? await analysisForSession(sessionId) : null;
      if (saved?.id === id.data) return saved;
      return reply.code(404).send({ error: 'Analysis not found' });
    });
  }, { prefix: '/admin' });
}
