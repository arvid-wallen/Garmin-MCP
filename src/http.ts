/** Long-running HTTP server (Railway, Fly, Docker, local development). */
import { serve } from '@hono/node-server';

import { createApp } from './create-app.js';
import { loadHttpConfig } from './config.js';

const config = loadHttpConfig();
const app = createApp(config);
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  const base = config.publicUrl ?? `http://localhost:${info.port}`;
  console.log(`[garmin-mcp] listening on ${hostname}:${info.port}; MCP endpoint ${base}/mcp`);
});
