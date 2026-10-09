// Talk to the shell brain like the trap would, without the trap:
//   npm run shell:repl            (control server at http://127.0.0.1:8080)
//   CONTROL_URL=https://... npm run shell:repl
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const base = process.env.CONTROL_URL || 'http://127.0.0.1:8080';
const headers = {
  'content-type': 'application/json',
  ...(process.env.INGEST_TOKEN ? { authorization: `Bearer ${process.env.INGEST_TOKEN}` } : {}),
};
const sessionId = process.env.SESSION_ID || randomUUID();

async function post(route: string, body: object) {
  const res = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const opened = await post('/v1/shell/open', { session_id: sessionId, callback_ip: '127.0.0.1', callback_port: 4444 });
console.error(`[session ${sessionId}]`);
process.stdout.write(opened.banner);

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
let prompt: string = opened.prompt;
process.stdout.write(prompt);
let seq = 0;
for await (const line of rl) {
  const r = await post('/v1/shell/cmd', { session_id: sessionId, seq: ++seq, command: line });
  if (process.env.SHOW_SOURCE) console.error(`[${r.served_by}, wait ${r.delay_ms}ms]`);
  await new Promise((ok) => setTimeout(ok, process.env.NO_DELAY ? 0 : r.delay_ms));
  process.stdout.write(r.output);
  if (r.close) break;
  prompt = r.prompt;
  process.stdout.write(prompt);
}
rl.close();
