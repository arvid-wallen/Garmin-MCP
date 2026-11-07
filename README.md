# Garmin MCP

An MCP server that gives Claude read access to your Garmin Connect data through
Garmin's official [Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api).
It runs in two modes:

- **Remote (HTTP):** deploy to Vercel (recommended) or Railway and add it as a custom
  connector in claude.ai, Claude Desktop, mobile or Claude Code. It includes its own
  OAuth 2.1 authorization server, so connecting means typing your owner password once.
- **Local (stdio):** run it on your machine for Claude Desktop or Claude Code, with no
  OAuth.

## What it can do

Every endpoint in Garmin's Personal API OpenAPI spec is covered (26 endpoints, the spec
is in [`docs/garmin-personal-api.openapi.json`](docs/garmin-personal-api.openapi.json)).
Some tools add work on top of the API.

| Area | Tools |
| --- | --- |
| Overview | `get_daily_overview` (summary, sleep, HRV, Body Battery and the day's activities in one call) |
| Daily wellness | `get_daily_summary`, `get_daily_summaries`, `get_steps`, `get_stress`, `get_hydration`, `get_heart_rate`, `get_body_battery`, `get_spo2` |
| Sleep and HRV | `get_sleep`, `get_sleep_summaries`, `get_hrv`, `get_hrv_summaries` |
| Body | `get_weight`, `get_weight_entries`, `get_weight_goals`, `get_fitness_age`, `get_heart_rate_zones`, `get_profile` |
| Nutrition | `get_nutrition` |
| Women's health | `get_menstrual_cycle_summary`, `get_menstrual_cycle_day` |
| Activities | `search_activities` (all 30 Garmin filters), `get_activity`, `get_activity_workouts`, `get_wellness_activities` |
| Activity analysis | `analyze_activity`: downloads the original FIT file and returns sessions, laps with pace (min/km for foot sports, min/100 m for swimming, km/h otherwise), time in HR and power zones, best efforts (5 s to 60 min power, fastest 400 m to marathon), beat-to-beat HRV, strength sets, swim lengths, devices and a downsampled time series (HR, speed, power, cadence, altitude, running dynamics, optional GPS) |
| Escape hatch | `garmin_api_get` for endpoints Garmin adds later |
| Local mode only | `save_activity_file` (writes the original ZIP or FIT to disk) |

There are also two prompts: `training_week_review` and `recovery_check`.

Behaviour that applies across all tools:

- Dates accept `YYYY-MM-DD`, `today`, `yesterday` and offsets like `-7d`, all resolved in
  `GARMIN_TIMEZONE`.
- Long ranges are split to fit Garmin's per-request limits (steps and stress 28 days;
  sleep, hydration and Body Battery 31 days; daily summaries 1 year) and merged back
  together.
- Results are kept under about 90k characters. Oversized arrays are evenly sampled, and
  the result says so.

### What Garmin's Personal API cannot do

Know these limits before you rely on the server:

- **It is read-only.** No endpoint creates workouts, schedules training, uploads courses or
  activities, or logs weight, food or water.
- There are no dedicated endpoints for Training Readiness, Training Status, Training Load
  or VO2 max trends. Some of these values appear inside activity and daily summary
  fields.
- Per-second activity data comes only from the original file, which `analyze_activity`
  parses. Manually entered or imported GPX/TCX activities have no FIT file to analyze.
- Personal API keys expire after at most one year. Garmin emails you before that happens.
  When it does, create a new key and update `GARMIN_PERSONAL_API_KEY`.

## 1. Get a Personal API key

Create a key at <https://connect.garmin.com/app/settings/personalApiToken>. It is shown
only once. The server exchanges it for a 24-hour bearer token and renews that token
automatically.

## 2a. Deploy to Vercel (recommended)

1. Import this repository in Vercel. The framework is detected as Hono and the entry
   point is `src/index.ts`. No build settings are needed.
2. Set environment variables for **Production**:

   | Variable | Value |
   | --- | --- |
   | `GARMIN_PERSONAL_API_KEY` | your key |
   | `AUTH_SECRET` | `openssl rand -hex 32` |
   | `OWNER_PASSWORD` | a long password you will type when connecting Claude |
   | `GARMIN_TIMEZONE` | e.g. `Europe/Stockholm` |
   | `PUBLIC_URL` | only with a custom domain, e.g. `https://garmin.example.com` |

3. Deploy, then open `https://<your-project>.vercel.app/`. It should return JSON with the
   `mcp_endpoint`.
4. Use the **production** domain. Vercel Deployment Protection blocks preview URLs for
   Claude.

### Why Vercel over Railway

This server keeps no state. OAuth artifacts are signed JWTs and the Garmin token is
re-derived from the key, so serverless costs nothing in functionality. Vercel then gives
you no servers to run, git-push deploys and a free tier that covers personal use.
Railway's advantages (a warm process and an in-memory Garmin token that survives between
requests) save one token exchange per cold start. The same code runs on both.

## 2b. Deploy to Railway (alternative)

Create a service from this repository and set the same variables. Railway runs
`npm run build` and `npm start`, which starts `dist/http.js` on `$PORT`. Generate a public
domain; `RAILWAY_PUBLIC_DOMAIN` is picked up automatically.

## 3. Connect Claude

- **claude.ai, Desktop and mobile:** Settings → Connectors → Add custom connector. Use
  the URL `https://<your-domain>/mcp`. Claude registers itself and opens the consent
  page. Enter `OWNER_PASSWORD` and approve.
- **Claude Code (remote):**

  ```bash
  claude mcp add --transport http garmin https://<your-domain>/mcp
  ```

  Then run `/mcp` in Claude Code to authenticate.

## Local mode (stdio)

```bash
npm install
npm run build
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/absolute/path/to/Garmin-MCP/dist/stdio.js"],
      "env": { "GARMIN_PERSONAL_API_KEY": "your-key", "GARMIN_TIMEZONE": "Europe/Stockholm" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add garmin -e GARMIN_PERSONAL_API_KEY=your-key -- node /absolute/path/to/Garmin-MCP/dist/stdio.js
```

## Security model

- The server is single-user. It acts as its own OAuth 2.1 authorization server: PKCE
  S256 is mandatory, Claude can register through dynamic client registration or Client ID
  Metadata Documents, and clients are public (no client secret). Approving a connection
  requires `OWNER_PASSWORD`. Failed logins are throttled (10 per IP and 50 in total per
  15 minutes, per instance).
- Redirect URIs are restricted to Claude's callbacks (`https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`), loopback addresses (Claude Code) and
  anything listed in `EXTRA_REDIRECT_URIS`.
- Access tokens last 1 hour and are bound to `<PUBLIC_URL>/mcp`. Refresh tokens last
  30 days and rotate on every use.
- Everything is stateless, signed with keys derived from `AUTH_SECRET`. Individual tokens
  cannot be revoked. To revoke everything, bump `TOKEN_VERSION` or rotate `AUTH_SECRET`;
  connected clients then have to sign in again. Single use of authorization codes and
  refresh tokens is enforced per warm instance.
- The Garmin API key never leaves the server and is never included in error messages.
- Garmin's terms limit the Personal API to personal use, so do not share the deployment.

## Development

```bash
npm install
npm test            # vitest: OAuth flow, MCP over HTTP, chunking, FIT analysis
npm run typecheck
cp .env.example .env && npm run dev   # local HTTP server on :3000
```

The tests use fake Garmin responses and synthetic FIT files, so they need no credentials.
