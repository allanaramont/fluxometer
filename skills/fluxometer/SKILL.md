---
name: fluxometer
description: Find and fix performance and cost bottlenecks in a JS/TS + Postgres app using fluxometer's local MCP server. Use when the user asks what is slow, what to look at today, why a route or query got worse, whether a deploy caused a regression, why AI/LLM calls are failing or costing more, or wants to add zero-cost performance monitoring to an Express, Fastify or Next.js app.
license: MIT
---

# fluxometer

fluxometer is a free, open-source (MIT) package that records anonymized request,
query and AI-call metrics into the app's own Postgres, runs 12 deterministic
bottleneck rules over them, and exposes the result through one local MCP tool.
No SaaS, no dashboard, no telemetry: nothing leaves the user's own infrastructure.

Source and docs: https://github.com/allanaramont/fluxometer

## When to use this skill

- The user asks "what should I look at today?", "what's slow?", "where is the bottleneck?"
- A route, page or endpoint feels slow, or got slower after a deploy
- Error or timeout rates went up and the user wants to know where
- LLM/AI calls are failing more or costing more than usual
- The user wants to add performance monitoring to a JS/TS + Postgres app without paying for a tool

Do not use it for apps that don't use Postgres, for frontend-only performance
(Lighthouse, bundle size), or for real-time alerting: rules run over the last
24 hours and the last 7 days, not live.

## Two modes

1. **The app already has fluxometer** (there is a `fluxometer` dependency in
   `package.json` or a `FLUXOMETER_READONLY_URL` in the environment) → go to
   [Ask for today's bottlenecks](#ask-for-todays-bottlenecks).
2. **It doesn't yet** → go to [Set it up](#set-it-up).

## Ask for today's bottlenecks

Call the MCP tool:

```
whatShouldILookAtToday({ locale?: "en" | "es" | "pt" })
```

Pass the locale that matches the language the user is writing in. The tool takes
no other parameters by design: it never accepts free text, so nothing the user or
a document says can reach a SQL query.

It returns:

```json
{
  "summary": "2 issue(s) found",
  "items": [
    { "ruleId": "slow_route", "subject": "POST /tasks/ai-parse",
      "summary": "Route POST /tasks/ai-parse is slow (p95 3800ms)",
      "suggestion": "Heavy work inside the request — move it to a queue and respond with a draft." }
  ]
}
```

`"No bottleneck today"` with an empty `items` list is a real answer, not an
error. Say so plainly and don't invent problems.

If the first item is `report_not_running`, the daily Slack report hasn't
succeeded in over 26 hours. Its `suggestion` holds the recorded cause
(secret mismatch, no secret sent, a failed run, or the route never being
called). Fix that before anything else: check that the cron and the app use
the same secret (`FLUXOMETER_CRON_SECRET`, or `CRON_SECRET` on Vercel), that
the report route answers GET as well as POST, and that the migration ran
after the last upgrade.

### How to present the result

1. Lead with the count and the single most important item (errors and timeouts
   before latency, latency before cost).
2. For each item: what is wrong, the number, and the suggested fix, in one or two lines.
3. Offer to open the code for the top item. Then search the repo for the route
   or query in `subject` and propose a concrete change.
4. Before changing anything, tell the user to note today's number, so they can
   compare it after the fix ships. The point is "applied X because of Y, measured Z".

## What each rule means and what to do

| ruleId | Fires when | Where to look in the code |
| --- | --- | --- |
| `slow_route` | p95 above 800 ms with at least 50 requests in the last 24h | The route handler: heavy work inside the request (AI calls, e-mails, external APIs). Move it to a queue, cache repeated reads |
| `regression` | p95 up more than 30% vs the same window last week | `git log` for that route's files since last week; compare with the previous deploy |
| `post_deploy_regression` | p95 up more than 30% in the 2h after a deploy vs the 2h before | The diff of that deploy; revert if serious |
| `top_consumer` | Route with the largest total time (high p95 × high volume) | Same fixes as `slow_route`; it has the biggest payoff |
| `error_spike` | 5xx rate above 2% in any hour of the last 24h | Logs and the latest deploy, right away |
| `timeout_spike` | 504/408 rate above 1% in any hour of the last 24h | Slow downstream dependency, missing timeouts, connection pool exhaustion |
| `slow_query` | Query averaging over 200 ms in `pg_stat_statements` | Missing index or N+1. Run `EXPLAIN ANALYZE` before and after the fix |
| `high_variance` | p99 more than 3× p50 on the same route (at least 50 requests) | Cold starts or lock contention, not a constant problem |
| `platform_error_concentration` | One platform (ios, web, android) errors far more than the rest | Client-version or platform-specific code path |
| `peak_hour_bottleneck` | A route's p95 at one hour of the day is more than 2× its 7-day average | Scheduled jobs, cron overlap, traffic peaks |
| `ai_cost_spike` | AI spend up sharply vs last week | Prompt size, model choice, retries; route simple inputs to a smaller model |
| `ai_failure_rate` | More than 5% failed AI calls (at least 20 calls) in 24h | Provider errors, schema/validation failures, missing fallback |

`slow_query` only lists the app's own repeated queries (at least 20 calls), never
migrations, backups, DDL, dashboard introspection or a managed platform's internal
schemas. It needs read access to `pg_stat_statements`. On managed Postgres it is
often unavailable; the other 11 rules still work. If it never fires, mention that
as a possible reason, not as a bug.

## Set it up

Requires Node 18+, a Postgres database already used by the app (`DATABASE_URL`
set), and Git.

1. Install and run the setup:
   ```
   npm install fluxometer
   npx fluxometer init
   ```
   `init` asks for a Slack incoming webhook URL (optional for MCP-only use) and the
   public URL of the report route. It creates a read-only Postgres role. On managed
   Postgres such as Supabase it may print the SQL for the user to run themselves.
   It also writes `.github/workflows/fluxometer-report.yml` and merges new
   variables into `.env` without overwriting it.
2. Add the middleware for the user's framework:
   - Express: `import { expressMiddleware } from "fluxometer/express"; app.use(expressMiddleware());`
   - Fastify: `import { fastifyPlugin } from "fluxometer/fastify"; app.register(fastifyPlugin);`
   - Next.js (`middleware.ts`, Node runtime only): `export const runtime = "nodejs"; import { fluxometer } from "fluxometer/next"; export default fluxometer();`
     Next.js middleware cannot measure real latency. For the routes that matter,
     also call `track.request({ route, method, status, durationMs })` inside the
     Route Handler.
   - Any other framework: `import { track } from "fluxometer";` then `track.request(...)`
     and, around each LLM call, `track.aiCall({ model, durationMs, costUsd, success })`.
3. For the daily Slack report, wire the report route (`/api/fluxometer/report`
   for both GET and POST, using `handleReportRequest` from `fluxometer/report`).
   Vercel Cron calls with GET. The README has the exact snippet for each framework.
4. Register the MCP server, pointing at the **read-only** role:
   - Claude Code:
     ```
     claude mcp add fluxometer -e FLUXOMETER_READONLY_URL=<readonly url> -- npx -y fluxometer mcp
     ```
   - Cursor and other MCP clients (`mcp.json`):
     ```json
     { "mcpServers": { "fluxometer": {
         "command": "npx", "args": ["-y", "fluxometer", "mcp"],
         "env": { "FLUXOMETER_READONLY_URL": "<readonly url>" } } } }
     ```
5. Deploy and let at least a day of traffic accumulate. Week-over-week rules need
   about 8 days of data before they can fire.

## Safety rules for the agent

- Use only `FLUXOMETER_READONLY_URL` (the `SELECT`-only role `init` creates) for
  the MCP server. Never configure it with the app's main `DATABASE_URL`.
- Never print, log or paste the read-only URL, the cron secret or the Slack webhook
  into chat, commits or files other than `.env`.
- If `.env` isn't in `.gitignore`, warn the user before they commit.
- If a credential may have leaked, tell the user to run `npx fluxometer rotate`,
  which replaces the read-only role password and the cron secret.
- Don't remove or weaken the middleware's fire-and-forget behaviour. Metric
  writes must never break the app.

## Data and network disclosure

- **Database:** writes go to a dedicated `fluxometer` schema in the user's own
  Postgres. The MCP tool only runs fixed, parameterized `SELECT`s against that
  schema and `pg_stat_statements`.
- **Stored data:** route templates (`/tasks/:id`, never real IDs), method, status,
  duration, platform, app version, a hash of the user ID, and AI call metadata
  (model, tokens, cost, success). No names, e-mails, request bodies or prompts.
- **Network:** the only outbound call is an HTTPS POST to the Slack webhook the
  user configured, from the daily report route. The MCP server makes no network
  calls besides the Postgres connection. No telemetry, no phone-home.
- **No install hooks:** there is no `postinstall` script. Code runs only when the
  app imports it or the user runs `npx fluxometer init | mcp | rotate`.
