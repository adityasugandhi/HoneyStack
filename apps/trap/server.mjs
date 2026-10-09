// HoneyStack trap: fake app + bait routes + /api/admin/diagnostics + capture.
// Node built-ins only. The trap NEVER runs attacker input — no shell-out and no
// dynamic code. Bait values come from response-map.json, never from the real env.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { openReverseShell } from './shell-connector.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapPath = [path.join(here, 'response-map.json'), path.join(here, '../../packages/trap/response-map.json')]
  .find(existsSync);
const RESPONSE_MAP = JSON.parse(readFileSync(mapPath, 'utf8'));
const PUBLIC_DIR = path.join(here, 'public');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4 = '\\d{1,3}(?:\\.\\d{1,3}){3}';
const SENSITIVE_KEY = /pass|secret|token|cookie|auth|key|credential/i;
const MAX_TEXT_CHARS = 2048;

// Single source of truth for the "leaked" synthetic admin token.
const ADMIN_TOKEN = (() => {
  try { return JSON.parse(RESPONSE_MAP['GET /api/env'].body).ADMIN_TOKEN; }
  catch { return 'synthetic_token_not_valid_anywhere'; }
})();

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        req.resume();
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

// ---- injection + reverse-shell detection (detection only; nothing is executed) ----

// Split a host field on shell metacharacters. parts[0] is the host to "ping";
// any remaining parts are extra commands an attacker chained on.
export function splitInjection(host) {
  return String(host)
    .split(/\$\(|\)|`|&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Return { ip, port } for a recognized reverse-shell payload, else null.
export function detectReverseShell(text) {
  const s = String(text);
  let m = s.match(new RegExp(`/dev/tcp/(${IPV4})/(\\d{1,5})`));
  if (m) return { ip: m[1], port: Number(m[2]) };
  m = s.match(new RegExp(`connect\\(\\(\\s*["'](${IPV4})["']\\s*,\\s*(\\d{1,5})`));
  if (m) return { ip: m[1], port: Number(m[2]) };
  if (/\b(?:nc|ncat|netcat)\b/.test(s)) {
    m = s.match(new RegExp(`(${IPV4})\\D+(\\d{1,5})`));
    if (m) return { ip: m[1], port: Number(m[2]) };
  }
  if (/sh\s+-i/.test(s)) {
    m = s.match(new RegExp(`(${IPV4})[:\\s]+(\\d{1,5})`));
    if (m) return { ip: m[1], port: Number(m[2]) };
  }
  return null;
}

function cannedPing(host) {
  const safe = String(host).slice(0, 80).replace(/[^\w.\-]/g, '');
  return `PING ${safe} (203.0.113.7): 56 data bytes\n` +
    `64 bytes from 203.0.113.7: icmp_seq=0 ttl=117 time=12.3 ms\n\n` +
    `--- ${safe} ping statistics ---\n` +
    `1 packets transmitted, 1 packets received, 0.0% packet loss\n` +
    `round-trip min/avg/max/stddev = 12.3/12.3/12.3/0.0 ms\n`;
}

// ---- control-server calls ----

function controlBase(env) {
  if (env.CONTROL_URL) return env.CONTROL_URL.replace(/\/$/, '');
  if (env.INGEST_URL) return env.INGEST_URL.replace(/\/v1\/events\/batch\/?$/, '').replace(/\/$/, '');
  return '';
}

async function controlPost(env, pathSuffix, payload) {
  const base = controlBase(env);
  if (!base || !env.INGEST_TOKEN) return null;
  try {
    const res = await fetch(`${base}${pathSuffix}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

export async function submitEvent(event, env) {
  const r = await controlPost(env, '/v1/events/batch', { events: [event] });
  return r !== null;
}

// ---- per-IP session tracking ----

function clientIp(req) {
  const raw = req.socket.remoteAddress || 'unknown';
  return raw.replace(/^::ffff:/, '');
}

export function makeEvent({ sessionId, method, route, payloadText, payloadBytes, template, status, instanceId }) {
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    observed_at: new Date().toISOString(),
    trap_instance_id: instanceId || 'unset',
    method,
    route,
    payload_text: payloadText,
    payload_bytes: payloadBytes,
    response_template: template,
    planned_status: status,
    origin_label: 'synthetic_fixture'
  };
}

function send(res, status, type, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function createTrap(env = process.env) {
  const limit = Number(env.BODY_LIMIT_BYTES) || 16384;
  const instanceId = env.TRAP_INSTANCE_ID || 'unset';
  const holdMs = env.REVSHELL_HOLD_MS !== undefined ? Number(env.REVSHELL_HOLD_MS) : 30000;
  const allowlist = (env.CALLBACK_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ipSessions = new Map(); // client ip -> session_id, reused for the callback
  const shell = { active: false };

  function sessionFor(req) {
    const hdr = req.headers['x-demo-session'];
    if (env.DEMO_MODE === 'true' && typeof hdr === 'string' && UUID_RE.test(hdr)) return hdr;
    const ip = clientIp(req);
    let sid = ipSessions.get(ip);
    if (!sid) { sid = randomUUID(); ipSessions.set(ip, sid); }
    return sid;
  }

  async function handleDiagnostics(req, res, body, sessionId) {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const evt = (template, status) => makeEvent({
      sessionId, method: req.method, route: '/api/admin/diagnostics',
      payloadText: body.tooLarge ? '[body exceeded limit]' : redactPayload(body.buf),
      payloadBytes: body.bytes, template, status, instanceId
    });

    if (token !== ADMIN_TOKEN) {
      await submitEvent(evt('diag-unauthorized', 401), env);
      return send(res, 401, 'application/json', '{"error":"unauthorized"}');
    }

    let host = '';
    try { host = String(JSON.parse(body.buf.toString('utf8')).host || ''); } catch { host = ''; }

    // Reverse-shell payload? Act like a real `bash -i` that connects out.
    const rs = detectReverseShell(host);
    if (rs) {
      if (allowlist.includes(rs.ip) && !shell.active) {
        const triggerEvent = evt('revshell-callback', 200);
        if (!(await submitEvent(triggerEvent, env))) return send(res, 503, 'text/plain; charset=utf-8', 'capture unavailable');
        shell.active = true;
        openReverseShell({
          ip: rs.ip, port: rs.port, sessionId, triggerEventId: triggerEvent.event_id,
          base: controlBase(env), token: env.INGEST_TOKEN
        }).finally(() => { shell.active = false; });
      } else {
        await submitEvent(evt('revshell-blocked', 200), env);
      }
      // A reverse shell daemonizes: the HTTP request hangs until the client gives up.
      await sleep(holdMs);
      return send(res, 200, 'text/plain; charset=utf-8', '');
    }

    // Command injection? First token is the host to ping; the rest are chained commands.
    const parts = splitInjection(host);
    const pingOut = cannedPing(parts[0] || host);
    if (parts.length > 1) {
      if (!(await submitEvent(evt('diag-injected', 200), env))) return send(res, 503, 'text/plain; charset=utf-8', 'capture unavailable');
      let out = pingOut;
      for (const command of parts.slice(1)) {
        const r = await controlPost(env, '/v1/shell/oneshot', { session_id: sessionId, command });
        out += (r && r.output) ? r.output : `sh: ${command}: command not found\n`;
      }
      return send(res, 200, 'text/plain; charset=utf-8', out);
    }

    // Plain host.
    if (!(await submitEvent(evt('diag-ping', 200), env))) return send(res, 503, 'text/plain; charset=utf-8', 'capture unavailable');
    return send(res, 200, 'text/plain; charset=utf-8', pingOut);
  }

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

    if (req.method === 'POST' && route === '/api/admin/diagnostics') {
      const body = await readBoundedBody(req, limit);
      if (body.aborted) return;
      if (body.tooLarge) return send(res, 413, 'text/plain; charset=utf-8', 'payload too large');
      const sessionId = sessionFor(req);
      return handleDiagnostics(req, res, body, sessionId);
    }

    const reply = fixedResponse(route, req.method);
    if (!reply) return send(res, 404, 'text/plain; charset=utf-8', 'not found');

    const body = await readBoundedBody(req, limit);
    if (body.aborted) return;
    const sessionId = sessionFor(req);
    const planned = body.tooLarge
      ? { template: 'payload-too-large', status: 413, contentType: 'text/plain; charset=utf-8', body: 'payload too large' }
      : reply;
    const event = makeEvent({
      sessionId, method: req.method, route,
      payloadText: body.tooLarge ? '[body exceeded limit]' : redactPayload(body.buf),
      payloadBytes: body.bytes, template: planned.template, status: planned.status, instanceId
    });
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
  server.requestTimeout = 0;      // diagnostics intentionally holds the socket open
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createTrap(process.env).listen(port, () => console.log(`trap listening on ${port}`));
}
