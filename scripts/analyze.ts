import { readFileSync } from 'node:fs';

// Run a Guild analysis for one session through the control server and print the result:
//   npm run analyze -- <session_id>
const base = process.env.CONTROL_URL || 'http://127.0.0.1:8080';
const headers = {
  'content-type': 'application/json',
  ...(process.env.CONTROL_TOKEN ? { authorization: `Bearer ${process.env.CONTROL_TOKEN}` } : {}),
};
// Default: the demo session in the shared fixture.
const sessionId = process.argv[2] || JSON.parse(readFileSync('tests/fixtures/demo-session.jsonl', 'utf8').split('\n')[0]).session_id;

const start = await fetch(`${base}/v1/analyze`, { method: 'POST', headers, body: JSON.stringify({ session_id: sessionId }) });
let job = await start.json();
if (!start.ok) throw new Error(`analyze -> HTTP ${start.status}: ${JSON.stringify(job)}`);
console.error(`analysis ${job.id} started; Guild session: ${job.guild_session_url}`);
while (job.state === 'running') {
  await new Promise((ok) => setTimeout(ok, 3000));
  job = await (await fetch(`${base}/v1/analysis/${job.id}`, { headers })).json();
  process.stderr.write('.');
}
console.error('');
console.log(JSON.stringify(job, null, 2));
process.exit(job.state === 'complete' ? 0 : 1);

