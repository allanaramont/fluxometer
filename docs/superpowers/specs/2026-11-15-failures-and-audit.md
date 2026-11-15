# fluxometer 0.6.0 — failures with a cause + generic audit events

## Why
`request_metrics` already stores one row per request, including 4xx/5xx
(route, status, duration, user hash). It says THAT a request failed, never WHY
or FOR WHOM. And there is nowhere to record "what changed" in an app. Both
are generic needs: any app that installs fluxometer should get them for free,
not rebuild them (the Fluxo Casa app built its own and wants to drop it).

## What
1. **`request_failures`** — one row per failed (4xx/5xx) request of a matched
   route: route pattern, method, status, duration, **error name, error code, a
   short sanitized message, correlation id, tenant**, user hash, platform.
   Filled automatically by the Express middleware; the app's error handler
   hands the cause over with `setFailureCause(res, {...})`.
2. **`audit_events`** — a generic "something changed" record, written with
   `track.audit({...})`: entity, action, target id, affected count, tenant,
   actor, source, route, method, correlation id, **field NAMES (never values)**,
   a free `effect` and free `tags`.
3. Read tools for an AI assistant (MCP): `recentFailures`, `recentAuditEvents`.
4. Both tables are pruned by the existing `cleanupOldRows` (30 days).

## Privacy (the library is for everyone, so safe by default)
- A failure's **message is OFF by default**: only name/code are stored. The
  host opts in with `failures: { captureMessage: true }`.
- Every message that is stored goes through `sanitizeMessage` (emails, tokens,
  long digit runs, URL query strings redacted; collapsed; truncated to 200),
  whether it comes from the middleware or from `track.failure` directly.
- Audit `fields` are names only by construction of the type; entries are
  capped (50 fields, 64 chars each). Values have nowhere to go.
- Unmatched routes are never recorded as failures (scanner noise; their raw
  path can carry tokens) — same rule as `request_metrics`'s `<unmatched>`.

## Non-goals
Fastify/Next adapters for failures (follow-up), a report section / rules over
these tables (follow-up: first collect real data), Prisma/ORM adapter for
audit (the host wires its own hook).

## Compatibility
Additive: two new tables via the idempotent `migrate()`. `expressMiddleware`
keeps working untouched; failures are collected by default but cost one insert
only for a failed request.
