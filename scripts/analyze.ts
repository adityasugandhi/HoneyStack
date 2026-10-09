// Run a Guild analysis for one session through the control server and print the result:
//   npm run analyze -- 5e55a1e0-7c3d-4b8e-9f21-6a0d3c9e4b17
const base = process.env.CONTROL_URL || 'http://127.0.0.1:8080';
const headers = {
  'content-type': 'application/json',
  ...(process.env.CONTROL_TOKEN ? { authorization: `Bearer ${process.env.CONTROL_TOKEN}` } : {}),
};
const sessionId = process.argv[2] ?? '5e55a1e0-7c3d-4b8e-9f21-6a0d3c9e4b17';

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

export {};
