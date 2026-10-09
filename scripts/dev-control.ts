// Local stand-in for apps/control/server.ts (owned by workstream C) so the shell brain and the
// Guild routes can run before the real control server exists. Port 8080, per docs/contracts.md.
import Fastify from 'fastify';
import { registerAnalysisRoutes } from '../apps/control/guild';
import { registerShellRoutes } from '../apps/control/shell-brain';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
registerShellRoutes(app);
registerAnalysisRoutes(app);

const port = Number(process.env.CONTROL_PORT || 8080);
await app.listen({ port, host: process.env.CONTROL_HOST || '127.0.0.1' });
