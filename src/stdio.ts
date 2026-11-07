/**
 * Local stdio entry point for Claude Desktop / Claude Code. No OAuth: the
 * process runs on your machine with GARMIN_PERSONAL_API_KEY in its environment.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadGarminConfig } from './config.js';
import { GarminClient } from './garmin/client.js';
import { createGarminServer } from './tools/index.js';

const client = new GarminClient(loadGarminConfig());
serveStdio(() => createGarminServer(client, { localFileAccess: true }), {
  onerror: (error) => console.error('[garmin-mcp]', error),
});
