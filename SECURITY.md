# Security

fluxometer has no backend of its own, no telemetry, and never "phones
home" — every credential stays in your own `.env`/secrets store.

## Credentials

| Credential                            | Origin                                                                                      | Lives in                                                                             | Worst-case leak                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `FLUXOMETER_SLACK_WEBHOOK_URL`        | You create it in Slack → Incoming Webhooks                                                  | Your app's `.env`                                                                    | Write-only: someone can post spam to the channel. It can't read anything.                               |
| `DATABASE_URL` (write)                | Already exists in your app                                                                  | Your app's `.env` (no new one)                                                       | Same risk your app already has today — this doesn't add surface.                                        |
| `FLUXOMETER_READONLY_URL` (read, MCP) | `init`/`rotate` create a Postgres role with `SELECT`-only access to the `fluxometer` schema | Your app's `.env` + your local MCP client config (e.g. `claude_desktop_config.json`) | Read access to anonymized metrics only — never real application data.                                   |
| `FLUXOMETER_CRON_SECRET`              | `init`/`rotate` generate a strong random string (32+ bytes)                                 | GitHub Actions secret / Vercel's native `CRON_SECRET` / your crontab host's env      | The report route returns 401 without it — compared in constant time, not vulnerable to a timing attack. |

## Your responsibility

- Keep `FLUXOMETER_READONLY_URL` out of version control. `init` warns if
  `.env` isn't gitignored, but never blocks the write — the decision to
  fix that is yours.
- Never reuse your app's main database credential for the MCP role.
- If a credential ever leaks, run `npx fluxometer rotate` immediately —
  it replaces both the readonly role's password and the cron secret in
  one call, and reports clearly if either half fails rather than
  silently claiming success.

## What the package does to reduce blast radius

- No PII in any table — only a `user_hash` and normalized routes. Even a
  full breach of the `fluxometer` schema exposes no real user data.
- No `postinstall` script — the CLI only runs when you explicitly call
  `npx fluxometer init` / `rotate` / `mcp`.
- Minimal runtime dependencies (`pg`, `fastify-plugin`,
  `@modelcontextprotocol/sdk`, `zod`) — less surface to audit in a
  package that runs inside your own app.
- MCP tools accept only typed/enum parameters — never free-form text
  that could reach a SQL query. This closes the "prompt injection →
  arbitrary query" path.
- The report route requires a constant-time-compared secret, plus a
  short duplicate-call guard.
- Metric writes are fire-and-forget and never throw into your
  application code, no matter what happens to the database connection.
- `.env` is written with explicit `0600` permissions (enforced with a
  `chmod` after every write, since Node's `writeFile` mode option is
  only applied when a file is newly created).

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public
issue.
