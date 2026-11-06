/**
 * Vercel entry point (Hono zero-config). Config is loaded lazily so a missing
 * environment variable produces a readable 500 instead of a crashed function.
 */
import { Hono } from 'hono';

import { createApp } from './app.js';
import { loadHttpConfig } from './config.js';

let app: ReturnType<typeof createApp> | undefined;
let configError: string | undefined;

function getApp() {
  if (app || configError) return app;
  try {
    app = createApp(loadHttpConfig());
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    console.error(`[garmin-mcp] configuration error: ${configError}`);
  }
  return app;
}

const root = new Hono();
root.all('*', (c) => {
  const inner = getApp();
  if (!inner) return c.json({ error: 'server_misconfigured', error_description: configError }, 500);
  return inner.fetch(c.req.raw);
});

export default root;
