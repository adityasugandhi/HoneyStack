// HoneyStack trap: fake app + 3 bait routes + capture. Node built-ins only.
// Never executes input. Bait values come from response-map.json, never from process.env.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapPath = [path.join(here, 'response-map.json'), path.join(here, '../../packages/trap/response-map.json')]
  .find(existsSync);
const RESPONSE_MAP = JSON.parse(readFileSync(mapPath, 'utf8'));
const PUBLIC_DIR = path.join(here, 'public');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY = /pass|secret|token|cookie|auth|key|credential/i;
const MAX_TEXT_CHARS = 2048;

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' }
};

export function normalizeRoute(url) {
  const raw = (url || '/').split('?')[0].split('#')[0];
  const lower = raw.toLowerCase();
  return lower.length > 1 ? lower.replace(/\/+$/, '') : lower;
}

export function fixedResponse(route, method) {
  return RESPONSE_MAP[`${method} ${route}`] || null;
}

export async function readBoundedBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > limit) {
        finish({ tooLarge: true, bytes: limit, buf: Buffer.alloc(0) });
        req.resume(); // discard the remainder without buffering
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ tooLarge: false, bytes, buf: Buffer.concat(chunks) }));
    req.on('error', () => finish({ aborted: true, bytes, buf: Buffer.alloc(0) }));
    req.on('aborted', () => finish({ aborted: true, bytes, buf: Buffer.alloc(0) }));
    req.on('close', () => finish({ aborted: true, bytes, buf: Buffer.alloc(0) }));
  });
}

function redactValue(v) {
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(val)]));
  }
  return v;
}

export function redactPayload(buf) {
  if (buf.length === 0) return '';
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return '[parse-failure: invalid text]';
  }
  try {
    text = JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    text = text.replace(/(pass(?:word)?|secret|token|key)\s*[=:]\s*\S+/gi, '$1=[redacted]');
  }
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '…[truncated]' : text;
}

export function makeRedactedEvent(req, body, route, reply, env) {
  const hdr = req.headers['x-demo-session'];
  const sessionId = env.DEMO_MODE === 'true' && typeof hdr === 'string' && UUID_RE.test(hdr) ? hdr : randomUUID();
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    observed_at: new Date().toISOString(),
    trap_instance_id: env.TRAP_INSTANCE_ID || 'unset',
    method: req.method,
    route,
    payload_text: body.tooLarge ? '[body exceeded limit]' : redactPayload(body.buf),
    payload_bytes: body.bytes,
    response_template: reply.template,
    planned_status: reply.status,
    origin_label: 'synthetic_fixture'
  };
}

export async function submitEvent(event, env) {
  if (!env.INGEST_URL || !env.INGEST_TOKEN) return false;
  try {
    const res = await fetch(env.INGEST_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(5000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function createTrap(env = process.env) {
  const limit = Number(env.BODY_LIMIT_BYTES) || 16384;

  async function handle(req, res) {
    const route = normalizeRoute(req.url);

    if (req.method === 'GET' && route === '/health') {
      return send(res, 200, 'application/json', '{"status":"ok"}');
    }
    if (req.method === 'GET' && STATIC[route]) {
      const { file, type } = STATIC[route];
      const p = path.join(PUBLIC_DIR, file);
      return existsSync(p) ? send(res, 200, type, readFileSync(p)) : send(res, 404, 'text/plain', 'not found');
    }

    const reply = fixedResponse(route, req.method);
    if (!reply) return send(res, 404, 'text/plain; charset=utf-8', 'not found');

    const body = await readBoundedBody(req, limit);
    if (body.aborted) return; // client disconnected; nothing to answer
    const planned = body.tooLarge
      ? { template: 'payload-too-large', status: 413, contentType: 'text/plain; charset=utf-8', body: 'payload too large' }
      : reply;
    const event = makeRedactedEvent(req, body, route, planned, env);
    const recorded = await submitEvent(event, env);
    if (!recorded) return send(res, 503, 'text/plain; charset=utf-8', 'capture unavailable');
    return send(res, planned.status, planned.contentType, planned.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'error');
      else res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createTrap(process.env).listen(port, () => console.log(`trap listening on ${port}`));
}
