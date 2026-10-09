// Reverse-shell relay. When the trap sees a reverse-shell payload aimed at an
// allowlisted IP, it opens a real TCP connection to that listener and relays
// each typed line to the shell brain (/v1/shell/cmd). Nothing runs here: every
// command's "output" is produced by the control server, not by this host.
import net from 'node:net';

const MAX_SESSION_MS = 15 * 60 * 1000; // hard cap on a live shell
const IDLE_MS = 2 * 60 * 1000;         // close after silence
const LINE_MAX = 16384;                // 16 KiB per input line

async function post(url, body, token) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

// opts: { ip, port, sessionId, triggerEventId, base, token }
// Returns a promise that resolves when the shell closes.
export async function openReverseShell(opts) {
  const { ip, port, sessionId, triggerEventId, base, token } = opts;
  if (!base || !token) return;

  const open = await post(`${base}/v1/shell/open`, {
    session_id: sessionId, trigger_event_id: triggerEventId,
    callback_ip: ip, callback_port: port
  }, token);
  if (!open) return; // control server declined; connect to nothing

  return new Promise((resolve) => {
    let seq = 0;
    let buf = '';
    let closed = false;
    let idleTimer = null;
    let hardTimer = null;
    const socket = net.connect(port, ip);

    const done = () => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      socket.destroy();
      resolve();
    };
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(done, IDLE_MS);
    };

    socket.setTimeout(0);
    socket.on('error', done);
    socket.on('close', done);
    hardTimer = setTimeout(done, MAX_SESSION_MS);

    socket.on('connect', () => {
      socket.write((open.banner || '') + (open.prompt || ''));
      bumpIdle();
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0 && !closed) {
        let line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length > LINE_MAX) line = line.slice(0, LINE_MAX);
        if (line.trim() === '') { socket.write(open.prompt || ''); continue; }
        bumpIdle();
        relay(line);
      }
      if (buf.length > LINE_MAX) buf = buf.slice(-LINE_MAX);
    });

    async function relay(command) {
      const r = await post(`${base}/v1/shell/cmd`, { session_id: sessionId, seq: ++seq, command }, token);
      if (closed) return;
      if (!r) { socket.write('bash: fork: retry: Resource temporarily unavailable\n'); return; }
      const write = () => {
        if (closed) return;
        socket.write((r.output || '') + (r.prompt || ''));
        if (r.close) done();
      };
      if (r.delay_ms > 0) setTimeout(write, r.delay_ms);
      else write();
    }
  });
}
