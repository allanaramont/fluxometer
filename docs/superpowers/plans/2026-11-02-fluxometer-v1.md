# Fluxometer v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `fluxometer` v1 — an npm package that any JS/TS + Postgres
app installs to get automated request/AI-cost metric collection, a daily
prioritized Slack summary, and a local MCP server for ad-hoc AI queries —
with zero paid infra, zero PII, and zero web dashboard.

**Architecture:** A core collector (writer + schema, isolated Postgres
schema) feeds a fixed deterministic rule engine. The rule engine is the
single source of truth consumed by two independent outputs — a Slack
formatter/sender (triggered once a day by an authenticated HTTP route any
external cron can call) and a local stdio MCP server (read-only Postgres
role). Framework adapters (Express/Fastify/Next.js) and a generic
`track()` wrap the core writer. A CLI (`init`/`rotate`) handles one-time
setup: migration, Slack webhook, read-only role, cron secret, workflow
templates.

**Tech Stack:** TypeScript, Node ≥18 (for global `fetch`), `pg` (node-
postgres) as the only runtime DB dependency, `@modelcontextprotocol/sdk`
for the MCP server, `vitest` for tests, no CLI framework (manual argv +
`node:readline`), no web framework dependency (adapters only import
framework types as devDependencies/peerDependencies).

**Spec:** `docs/superpowers/specs/2026-11-02-fluxometer-design.md`

## Global Constraints

- JS/TS + Postgres only (spec: Goals).
- Zero paid infra; cron must work via a single authenticated HTTP call
  any external scheduler can make — GitHub Actions / Vercel Cron
  templates generated, plain `curl`+crontab also valid (spec: Goals,
  Decisões já tomadas).
- No `postinstall` script; minimal runtime dependencies (spec: Segurança).
- All Postgres objects live in an isolated `fluxometer` schema; migration
  SQL is idempotent and never touches the host app's own tables/migration
  tooling (spec: Constraints).
- No PII in any table — only `user_hash` and normalized routes; raw rows
  older than 30 days purged daily (spec: Goals, Privacidade).
- Metric writes are fire-and-forget, use a small dedicated lazy pool
  (max 2 connections), and must never throw into host app code (spec:
  Constraints, Segurança).
- Cron report route requires `FLUXOMETER_CRON_SECRET` compared with
  `crypto.timingSafeEqual`, plus a short-window duplicate-call guard
  (spec: Segurança).
- MCP tools never accept free-form SQL/strings that reach a query — fixed,
  parameterized queries with typed/enum inputs only (spec: Segurança).
- Rule engine is fixed/deterministic — no LLM call inside the package
  (spec: Non-goals).
- i18n catalog covers `en` (default), `es`, `pt`, selected via
  `FLUXOMETER_LOCALE` (spec: Goals).
- License: MIT. Package/repo name: `fluxometer`.

## Review Focus

- A metric write fails (dropped connection, bad schema) mid-request — the
  host app's response must still complete normally, with one logged
  warning, never an unhandled rejection or thrown error.
- The cron route is called with no header, a wrong secret, or the same
  valid call twice within the duplicate-call window — only a valid,
  non-duplicate call may trigger the (expensive) report computation.
- `pg_stat_statements` is unreadable (permission denied / extension
  missing, e.g. non-superuser Supabase role) — the engine disables only
  the slow-query rule and still returns results for the other ~11 rules.
- `npx fluxometer init` runs without `DATABASE_URL` set — it exits with a
  clear, specific message, never a raw stack trace or a silent hang.
- An MCP tool receives an out-of-range or unsupported parameter (e.g. an
  unknown time-window enum value or unsupported locale) — it returns a
  typed error result, never falls through to building a dynamic query
  string from the input.

---

## File Structure

```
fluxometer/
  package.json
  tsconfig.json
  vitest.config.ts
  .github/workflows/ci.yml
  src/
    core/
      schema.ts        -- isolated-schema migration SQL + runMigration()
      pool.ts           -- lazy small Pool factory (collector side)
      writer.ts          -- trackRequest/trackClientMetric/trackAiCall, cleanupOldRows
      types.ts           -- shared row/result types
    adapters/
      express.ts
      fastify.ts
      next.ts
      generic.ts         -- re-exports track() = writer functions directly
    rules/
      queries.ts         -- one exported SQL-backed function per rule
      catalog.ts          -- RULES: ordered list of {id, severity fn, compute}
      engine.ts            -- runEngine(pool, opts) -> RuleResult[]
      i18n/
        catalog.ts          -- message templates keyed by rule id + locale
        index.ts             -- resolveMessage(locale, ruleId, params)
    report/
      slackFormat.ts        -- RuleResult[] -> Slack markdown string
      slackSend.ts           -- postToSlack(webhookUrl, text)
      auth.ts                 -- verifyCronSecret(), duplicate-call guard
      route.ts                 -- framework-agnostic handleReportRequest()
    mcp/
      tools.ts                -- tool definitions (typed inputs only)
      server.ts                 -- createMcpServer() using @modelcontextprotocol/sdk
    cli/
      argv.ts                  -- tiny argv parser (command + flags)
      init.ts                    -- init command
      rotate.ts                   -- rotate command
      templates.ts                 -- GitHub Actions + Vercel Cron template strings
      bin.ts                        -- #!/usr/bin/env node entry, dispatches commands
  test/
    core/schema.test.ts
    core/writer.test.ts
    adapters/express.test.ts
    adapters/fastify.test.ts
    adapters/next.test.ts
    rules/engine.test.ts
    rules/i18n.test.ts
    report/slackFormat.test.ts
    report/route.test.ts
    mcp/tools.test.ts
    cli/init.test.ts
    cli/rotate.test.ts
  README.md
  SECURITY.md
```

Tests that need a real Postgres (`core/schema`, `core/writer`,
`rules/engine`, `report/route`, `mcp/tools`, `cli/init`, `cli/rotate`) read
`process.env.TEST_DATABASE_URL`; `.github/workflows/ci.yml` provides one
via the `postgres` service container. This is stated once here, not
repeated per task.

---

### Task 1: Scaffolding + isolated schema migration

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `.github/workflows/ci.yml` (installs deps, spins up a
  `postgres:16` service, runs `npm run lint`, `npm test`, `npm run build`)
- Create: `src/core/schema.ts`
- Test: `test/core/schema.test.ts`

**Interfaces:**

- Produces: `SCHEMA_NAME = 'fluxometer'`; `async function runMigration(pool: Pool): Promise<void>` — creates schema + `request_metrics`, `client_metrics`, `ai_calls` tables (columns per spec's `Goals` section) if not already present.

- [ ] **Step 1: Write the failing test**

```ts
// test/core/schema.test.ts
it("creates the fluxometer schema and its three tables idempotently", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await runMigration(pool);
  await runMigration(pool); // second call must not throw
  const { rows } = await pool.query(
    `select table_name from information_schema.tables where table_schema = 'fluxometer'`,
  );
  expect(rows.map((r) => r.table_name).sort()).toEqual([
    "ai_calls",
    "client_metrics",
    "request_metrics",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- core/schema` — Expected: FAIL (`runMigration` not defined / tables don't exist).

- [ ] **Step 3: Implement `runMigration(pool: Pool): Promise<void>` in `src/core/schema.ts`**

Idempotent SQL (`create schema if not exists fluxometer; create table if
not exists fluxometer.request_metrics (...)`, same for `client_metrics`,
`ai_calls`) per the three table definitions in the spec's Goals section.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- core/schema` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .github/workflows/ci.yml src/core/schema.ts test/core/schema.test.ts
git commit -m "feat: scaffold package and isolated schema migration"
```

---

### Task 2: Lazy pool + fire-and-forget writer + cleanup

**Files:**

- Create: `src/core/pool.ts`, `src/core/writer.ts`, `src/core/types.ts`
- Test: `test/core/writer.test.ts`

**Interfaces:**

- Consumes: `SCHEMA_NAME`, `runMigration` (Task 1).
- Produces: `trackRequest(input: RequestMetric): void`, `trackClientMetric(input: ClientMetric): void`, `trackAiCall(input: AiCallMetric): void` — all synchronous (fire-and-forget internally), never throw, never return a rejected promise to the caller. `cleanupOldRows(pool: Pool, olderThanDays = 30): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
it("trackRequest never throws even if the write fails", () => {
  const brokenPool = {
    query: () => Promise.reject(new Error("down")),
  } as unknown as Pool;
  setPoolForTesting(brokenPool);
  expect(() =>
    trackRequest({ route: "/x", method: "GET", status: 200, durationMs: 10 }),
  ).not.toThrow();
});

it("trackRequest writes a row with a normalized route and no PII fields", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await runMigration(pool);
  setPoolForTesting(pool);
  trackRequest({
    route: "/tasks/:id",
    method: "GET",
    status: 200,
    durationMs: 42,
    userHash: "h1",
    platform: "web",
  });
  await flushForTesting(); // drains the internal fire-and-forget queue
  const { rows } = await pool.query(`select * from fluxometer.request_metrics`);
  expect(rows[0]).toMatchObject({
    route: "/tasks/:id",
    duration_ms: 42,
    platform: "web",
  });
});

it("cleanupOldRows deletes rows older than the cutoff and keeps recent ones", async () => {
  /* seed one old + one recent row, assert count */
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- core/writer` — Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement pool + writer + cleanup**

`src/core/pool.ts`: `getPool(): Pool` lazily creates a `Pool` with
`max: 2` from `process.env.DATABASE_URL` on first use;
`setPoolForTesting(pool)`/`flushForTesting()` test seams. `src/core/writer.ts`:
each `track*` function builds an `INSERT` and calls `.catch(err => logOnce(...))`
on the promise — never awaited by the caller, never rethrown.
`cleanupOldRows` runs one parameterized `DELETE ... WHERE created_at < now() - interval '$1 days'` per table.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- core/writer` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/pool.ts src/core/writer.ts src/core/types.ts test/core/writer.test.ts
git commit -m "feat: add fire-and-forget metric writer and cleanup job"
```

---

### Task 3: Express adapter

**Files:**

- Create: `src/adapters/express.ts`
- Test: `test/adapters/express.test.ts`

**Interfaces:**

- Consumes: `trackRequest` (Task 2).
- Produces: `function expressMiddleware(opts?: { platform?: string }): (req, res, next) => void`.

- [ ] **Step 1: Write the failing test**

```ts
it("calls trackRequest with normalized route, status and duration after the response finishes", async () => {
  const trackSpy = vi.spyOn(writer, "trackRequest");
  const app = express();
  app.use(expressMiddleware());
  app.get("/tasks/:id", (req, res) => res.status(200).send("ok"));
  await request(app).get("/tasks/42");
  expect(trackSpy).toHaveBeenCalledWith(
    expect.objectContaining({ route: "/tasks/:id", status: 200 }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- adapters/express` — Expected: FAIL.

- [ ] **Step 3: Implement `expressMiddleware`**

Reads `req.route?.path` (Express's own normalized path) after
`res.on('finish', ...)`, measures duration via `process.hrtime.bigint()`
taken before `next()`, calls `trackRequest` in the `finish` handler (after
the response is already sent).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- adapters/express` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/express.ts test/adapters/express.test.ts
git commit -m "feat: add Express adapter"
```

---

### Task 4: Fastify adapter

**Files:**

- Create: `src/adapters/fastify.ts`
- Test: `test/adapters/fastify.test.ts`

**Interfaces:**

- Consumes: `trackRequest` (Task 2).
- Produces: `function fastifyPlugin(fastify: FastifyInstance, opts?: { platform?: string }): void` (registered via `fastify.register`).

- [ ] **Step 1: Write the failing test**

```ts
it("calls trackRequest with the route pattern and status after the response is sent", async () => {
  const trackSpy = vi.spyOn(writer, "trackRequest");
  const app = Fastify();
  app.register(fastifyPlugin);
  app.get("/tasks/:id", async () => "ok");
  await app.inject({ method: "GET", url: "/tasks/42" });
  expect(trackSpy).toHaveBeenCalledWith(
    expect.objectContaining({ route: "/tasks/:id", status: 200 }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- adapters/fastify` — Expected: FAIL.

- [ ] **Step 3: Implement `fastifyPlugin`**

Uses Fastify's `onResponse` hook; route pattern from
`request.routeOptions.url` (Fastify's normalized pattern); duration from
`reply.elapsedTime`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- adapters/fastify` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/fastify.ts test/adapters/fastify.test.ts
git commit -m "feat: add Fastify adapter"
```

---

### Task 5: Next.js adapter + generic `track()`

**Files:**

- Create: `src/adapters/next.ts`, `src/adapters/generic.ts`
- Test: `test/adapters/next.test.ts`

**Interfaces:**

- Consumes: `trackRequest`, `trackClientMetric`, `trackAiCall` (Task 2).
- Produces: `src/adapters/generic.ts` re-exports `{ track: { request: trackRequest, clientMetric: trackClientMetric, aiCall: trackAiCall } }`; `src/adapters/next.ts` exports `fluxometer(middleware?: NextMiddleware): NextMiddleware` wrapping a user's existing `middleware.ts` export, documented as requiring `export const runtime = 'nodejs'` (spec: Decisões já resolvidas pelo builder — no Edge support).

- [ ] **Step 1: Write the failing test**

```ts
it("wraps an existing Next.js middleware and still calls trackRequest, forwarding the original response", async () => {
  const trackSpy = vi.spyOn(writer, "trackRequest");
  const wrapped = fluxometer((req) => NextResponse.next());
  const res = await wrapped(
    buildMockNextRequest({ nextUrl: { pathname: "/tasks/42" } }),
    {} as any,
  );
  expect(res).toBeInstanceOf(NextResponse);
  expect(trackSpy).toHaveBeenCalledWith(
    expect.objectContaining({ route: "/tasks/42" }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- adapters/next` — Expected: FAIL.

- [ ] **Step 3: Implement `fluxometer()` wrapper and `generic.ts`**

Calls the wrapped middleware (or a pass-through `NextResponse.next()` if
none given), measures elapsed time around that call, calls `trackRequest`
with `req.nextUrl.pathname`, returns the original response unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- adapters/next` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/next.ts src/adapters/generic.ts test/adapters/next.test.ts
git commit -m "feat: add Next.js adapter and generic track() export"
```

---

### Task 6: Rule engine (12 fixed rules)

**Files:**

- Create: `src/rules/queries.ts`, `src/rules/catalog.ts`, `src/rules/engine.ts`
- Test: `test/rules/engine.test.ts`

**Interfaces:**

- Consumes: `fluxometer.request_metrics`/`ai_calls` tables (Task 1), a Postgres `Pool`.
- Produces:

  ```ts
  type RuleId =
    | "slow_route"
    | "regression"
    | "top_consumer"
    | "error_spike"
    | "slow_query"
    | "high_variance"
    | "platform_error_concentration"
    | "timeout_spike"
    | "ai_cost_spike"
    | "ai_failure_rate"
    | "peak_hour_bottleneck"
    | "post_deploy_regression";
  type RuleResult = {
    ruleId: RuleId;
    severity: "high" | "medium";
    subject: string;
    metrics: Record<string, number | string>;
  };
  async function runEngine(pool: Pool): Promise<RuleResult[]>; // sorted, most severe/highest-impact first
  ```

- [ ] **Step 1: Write the failing test**

```ts
it("flags a route as slow_route when p95 exceeds the threshold with enough volume, and ranks it before a route with less total time", async () => {
  // seed 60 rows on /slow with duration_ms ~1000, 60 rows on /fast with duration_ms ~50
  const results = await runEngine(pool);
  expect(results[0]).toMatchObject({ ruleId: "slow_route", subject: "/slow" });
});

it("disables only slow_query when pg_stat_statements is unreadable, and still returns the other rules", async () => {
  vi.spyOn(pool, "query").mockImplementation((sql: string) =>
    sql.includes("pg_stat_statements")
      ? Promise.reject(new Error("permission denied"))
      : realQuery(sql),
  );
  const results = await runEngine(pool);
  expect(results.some((r) => r.ruleId === "slow_query")).toBe(false);
  expect(results.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- rules/engine` — Expected: FAIL.

- [ ] **Step 3: Implement `queries.ts`, `catalog.ts`, `engine.ts`**

One exported async function per rule in `queries.ts` (each takes `pool`,
returns `RuleResult[]` for that rule, using the windows/thresholds from
the spec: p95 > 800ms & ≥50 reqs/day for `slow_route`; p95 regression

> 30% week-over-week for `regression`; top 3 by `sum(duration_ms)` for
> `top_consumer`; 5xx rate >2%/hour for `error_spike`; `pg_stat_statements`
> mean >200ms for `slow_query`; p99/p50 ratio above a fixed multiplier for
> `high_variance`; error rate concentrated >1 platform stdev for
> `platform_error_concentration`; 5xx rate specifically on timeout-shaped
> statuses for `timeout_spike`; `ai_calls` cost/call up without call-count
> up for `ai_cost_spike`; `success = false` rate above threshold for
> `ai_failure_rate`; bottleneck confined to an hour-of-day bucket for
> `peak_hour_bottleneck`; regression within N hours of the latest deploy
> marker for `post_deploy_regression`). `catalog.ts` lists the 12 rule
> functions in one array. `engine.ts`'s `runEngine` runs each rule function
> with its own `try/catch` (one failing rule never aborts the others) and
> sorts the combined results by severity then impact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- rules/engine` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rules/queries.ts src/rules/catalog.ts src/rules/engine.ts test/rules/engine.test.ts
git commit -m "feat: add fixed 12-rule bottleneck engine"
```

---

### Task 7: i18n catalog

**Files:**

- Create: `src/rules/i18n/catalog.ts`, `src/rules/i18n/index.ts`
- Test: `test/rules/i18n.test.ts`

**Interfaces:**

- Consumes: `RuleId`, `RuleResult` (Task 6).
- Produces: `function resolveMessage(locale: 'en' | 'es' | 'pt', result: RuleResult): { summary: string; suggestion: string }`.

- [ ] **Step 1: Write the failing test**

```ts
it("resolves slow_route in all three locales with the route interpolated", () => {
  const result: RuleResult = {
    ruleId: "slow_route",
    severity: "high",
    subject: "/tasks/ai-parse",
    metrics: { p95: 3800 },
  };
  expect(resolveMessage("en", result).summary).toContain("/tasks/ai-parse");
  expect(resolveMessage("pt", result).summary).toContain("/tasks/ai-parse");
  expect(resolveMessage("es", result).summary).toContain("/tasks/ai-parse");
});

it("falls back to en for an unknown locale instead of throwing", () => {
  expect(() =>
    resolveMessage("fr" as any, {
      ruleId: "slow_route",
      severity: "high",
      subject: "/x",
      metrics: {},
    }),
  ).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- rules/i18n` — Expected: FAIL.

- [ ] **Step 3: Implement catalog + resolver**

`catalog.ts`: a `Record<RuleId, Record<'en'|'es'|'pt', { summary: (m) => string; suggestion: (m) => string }>>` with one entry per rule (12 rules × 3 locales), summary/suggestion text drawn from the spec's rule list. `index.ts`'s `resolveMessage` looks up `catalog[result.ruleId][locale] ?? catalog[result.ruleId].en`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- rules/i18n` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rules/i18n test/rules/i18n.test.ts
git commit -m "feat: add en/es/pt i18n catalog for rule messages"
```

---

### Task 8: Slack formatter + sender

**Files:**

- Create: `src/report/slackFormat.ts`, `src/report/slackSend.ts`
- Test: `test/report/slackFormat.test.ts`

**Interfaces:**

- Consumes: `RuleResult[]` (Task 6), `resolveMessage` (Task 7).
- Produces: `function formatSlackReport(results: RuleResult[], locale: Locale): string` (Slack `mrkdwn`); `async function postToSlack(webhookUrl: string, text: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
it("formats a ranked list with summary and suggestion per result", () => {
  const text = formatSlackReport(
    [
      {
        ruleId: "slow_route",
        severity: "high",
        subject: "/tasks/ai-parse",
        metrics: { p95: 3800 },
      },
    ],
    "en",
  );
  expect(text).toContain("/tasks/ai-parse");
  expect(text).toMatch(/Performance/i);
});

it("says there is nothing to report when the results list is empty", () => {
  expect(formatSlackReport([], "en")).toMatch(/no bottleneck/i);
});

it("postToSlack POSTs the text as the webhook payload", async () => {
  const fetchSpy = vi
    .spyOn(global, "fetch")
    .mockResolvedValue(new Response(null, { status: 200 }));
  await postToSlack("https://hooks.slack.com/services/x", "hello");
  expect(fetchSpy).toHaveBeenCalledWith(
    "https://hooks.slack.com/services/x",
    expect.objectContaining({ method: "POST" }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- report/slackFormat` — Expected: FAIL.

- [ ] **Step 3: Implement formatter + sender**

`formatSlackReport` builds the `*Performance — últimas 24h*` block shape
from the spec's example, one bullet per `RuleResult` via `resolveMessage`;
empty-list branch returns a "no bottleneck today" line (spec: "Se nenhuma
regra disparar, o resumo diz isso"). `postToSlack` does a plain
`fetch(webhookUrl, { method: 'POST', body: JSON.stringify({ text }) })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- report/slackFormat` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report/slackFormat.ts src/report/slackSend.ts test/report/slackFormat.test.ts
git commit -m "feat: add Slack report formatter and webhook sender"
```

---

### Task 9: Cron auth + report HTTP route

**Files:**

- Create: `src/report/auth.ts`, `src/report/route.ts`
- Test: `test/report/route.test.ts`

**Interfaces:**

- Consumes: `runEngine` (Task 6), `formatSlackReport`, `postToSlack` (Task 8), `cleanupOldRows` (Task 2).
- Produces: `function verifyCronSecret(headerValue: string | undefined, expected: string): boolean` (constant-time); `async function handleReportRequest(req: { header: (name: string) => string | undefined }): Promise<{ status: number; body: string }>` — framework-agnostic; adapters' route wiring is documented in the README, not re-implemented per framework in this task.

- [ ] **Step 1: Write the failing test**

```ts
it("rejects with 401 when the secret header is missing or wrong", async () => {
  const res = await handleReportRequest({ header: () => undefined });
  expect(res.status).toBe(401);
});

it("runs the engine and sends to Slack exactly once for a valid request, and ignores an identical duplicate within the guard window", async () => {
  const req = {
    header: (n: string) =>
      n === "x-fluxometer-secret"
        ? process.env.FLUXOMETER_CRON_SECRET
        : undefined,
  };
  const sendSpy = vi.spyOn(slackSend, "postToSlack").mockResolvedValue();
  await handleReportRequest(req);
  await handleReportRequest(req); // duplicate within the window
  expect(sendSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- report/route` — Expected: FAIL.

- [ ] **Step 3: Implement `auth.ts` and `route.ts`**

`verifyCronSecret` pads both strings and uses
`crypto.timingSafeEqual`. `handleReportRequest` checks
`verifyCronSecret`, then an in-memory last-run timestamp (duplicate-call
guard — short fixed window, e.g. 5 minutes) before calling `runEngine` →
`formatSlackReport` → `postToSlack`, then `cleanupOldRows`; returns
`{ status: 200, body: 'ok' }` on success.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- report/route` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report/auth.ts src/report/route.ts test/report/route.test.ts
git commit -m "feat: add authenticated report route (engine + Slack + cleanup)"
```

---

### Task 10: MCP server

**Files:**

- Create: `src/mcp/tools.ts`, `src/mcp/server.ts`
- Test: `test/mcp/tools.test.ts`

**Interfaces:**

- Consumes: `runEngine` (Task 6), `resolveMessage` (Task 7).
- Produces: `async function whatShouldILookAtToday(input: { locale?: 'en' | 'es' | 'pt' }): Promise<{ summary: string; items: { ruleId: string; subject: string; summary: string; suggestion: string }[] }>`; `function createMcpServer(): Server` (wires the tool via `@modelcontextprotocol/sdk`, connects with the `FLUXOMETER_READONLY_URL` pool).

- [ ] **Step 1: Write the failing test**

```ts
it("returns the ranked rule results with resolved messages for a given locale", async () => {
  const result = await whatShouldILookAtToday({ locale: "pt" });
  expect(result.items[0]).toHaveProperty("suggestion");
});

it("rejects an unsupported locale with a typed error instead of building a dynamic query", async () => {
  await expect(
    whatShouldILookAtToday({ locale: "fr" as any }),
  ).rejects.toMatchObject({ code: "invalid_locale" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mcp/tools` — Expected: FAIL.

- [ ] **Step 3: Implement `tools.ts` and `server.ts`**

`whatShouldILookAtToday` validates `locale` against the fixed
`['en','es','pt']` enum up front (throws `{ code: 'invalid_locale' }`
before touching the engine), then calls `runEngine` + `resolveMessage` per
result. `createMcpServer` registers this as the one MCP tool with a
JSON-schema input restricted to that enum (no free-text parameter),
connecting its own small pool from `FLUXOMETER_READONLY_URL`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mcp/tools` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts test/mcp/tools.test.ts
git commit -m "feat: add local MCP server exposing whatShouldILookAtToday"
```

---

### Task 11: CLI `init`

**Files:**

- Create: `src/cli/argv.ts`, `src/cli/templates.ts`, `src/cli/init.ts`, `src/cli/bin.ts`
- Test: `test/cli/init.test.ts`

**Interfaces:**

- Consumes: `runMigration` (Task 1).
- Produces: `async function runInit(opts: { prompt: (q: string) => Promise<string>; env: NodeJS.ProcessEnv; fs: typeof fsPromises }): Promise<void>` (dependencies injected for testability); `githubActionsTemplate(opts): string`, `vercelCronTemplate(opts): string`.

- [ ] **Step 1: Write the failing test**

```ts
it("exits with a clear message and does not touch the database when DATABASE_URL is missing", async () => {
  await expect(
    runInit({ prompt: vi.fn(), env: {}, fs: fakeFs }),
  ).rejects.toMatchObject({ code: "missing_database_url" });
});

it("creates the schema, writes .env entries, generates the workflow file, and warns if .env is not gitignored", async () => {
  const fakeFs = createFakeFs({ files: { ".gitignore": "node_modules\n" } });
  const prompt = vi
    .fn()
    .mockResolvedValue("https://hooks.slack.com/services/x");
  await runInit({
    prompt,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
    fs: fakeFs,
  });
  expect(fakeFs.readFile(".env")).toContain("FLUXOMETER_SLACK_WEBHOOK_URL");
  expect(fakeFs.readFile(".github/workflows/fluxometer-report.yml")).toContain(
    "schedule",
  );
  expect(fakeFs.warnings).toContainEqual(
    expect.stringMatching(/\.env.*gitignore/i),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cli/init` — Expected: FAIL.

- [ ] **Step 3: Implement `runInit` and templates**

Order: validate `DATABASE_URL` present → `runMigration` → prompt for
Slack webhook URL → attempt `CREATE ROLE fluxometer_readonly` with a
`crypto.randomBytes(32)` password (catch permission errors and print the
SQL instead of throwing) → generate `FLUXOMETER_CRON_SECRET`
(`randomBytes(32).toString('hex')`) and try `execFile('gh', ['secret',
'set', ...])`, falling back to printing the value → write `.env` entries
→ write `githubActionsTemplate`/`vercelCronTemplate` output to
`.github/workflows/fluxometer-report.yml` / `vercel.json` snippet → check
`.gitignore` for a `.env` line and push a warning if absent (never
throws). `bin.ts` dispatches `init`/`rotate`/`mcp` via `argv.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cli/init` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/argv.ts src/cli/templates.ts src/cli/init.ts src/cli/bin.ts test/cli/init.test.ts
git commit -m "feat: add fluxometer init CLI command"
```

---

### Task 12: CLI `rotate`

**Files:**

- Create: `src/cli/rotate.ts`
- Test: `test/cli/rotate.test.ts`

**Interfaces:**

- Consumes: read-only role creation logic factored out of Task 11 (`createReadonlyRole` extracted into a shared helper if not already standalone).
- Produces: `async function runRotate(opts: { env: NodeJS.ProcessEnv; fs: typeof fsPromises }): Promise<{ newReadonlyUrl: string; newCronSecret: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
it("creates a new readonly role and cron secret, revokes the old role, and rewrites .env", async () => {
  const fakeFs = createFakeFs({
    files: {
      ".env": "FLUXOMETER_READONLY_URL=old\nFLUXOMETER_CRON_SECRET=oldsecret\n",
    },
  });
  const result = await runRotate({
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
    fs: fakeFs,
  });
  expect(result.newCronSecret).not.toBe("oldsecret");
  expect(fakeFs.readFile(".env")).toContain(result.newCronSecret);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cli/rotate` — Expected: FAIL.

- [ ] **Step 3: Implement `runRotate`**

Creates a new readonly role/password, `DROP ROLE` (or revoke+rename) the
previous one, generates a new cron secret, rewrites the relevant `.env`
lines in place (keeping unrelated lines untouched).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cli/rotate` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/rotate.ts test/cli/rotate.test.ts
git commit -m "feat: add fluxometer rotate CLI command"
```

---

### Task 13: README + SECURITY.md + package metadata

**Files:**

- Create: `README.md`, `SECURITY.md`
- Modify: `package.json` (bin entry `fluxometer` → `dist/cli/bin.js`, `license: MIT`, exports map for `fluxometer/express`, `fluxometer/fastify`, `fluxometer/next`)

**Interfaces:**

- Consumes: nothing new — this task only documents and wires up what Tasks 1-12 already built.

- [ ] **Step 1: Write the install-flow walkthrough in `README.md`**

Mirrors the spec's "Checklist de instalação" 9 steps verbatim (install,
init, webhook prompt, readonly role fallback SQL, cron secret, workflow
files, `.gitignore` check, one adapter line, deploy; plus the `rotate`
escape hatch).

- [ ] **Step 2: Write `SECURITY.md`**

Documents the credential table from the spec's "Modelo de credenciais"
section and the installer's responsibility for the readonly URL, per the
spec.

- [ ] **Step 3: Verify the package builds and lints clean**

Run: `npm run build && npm run lint` — Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md SECURITY.md package.json
git commit -m "docs: add README install walkthrough and SECURITY.md"
```

---

## Self-Review

**Spec coverage:** schema/isolation (Task 1), fire-and-forget writer +
30-day cleanup (Task 2), Express/Fastify/Next/generic adapters (Tasks
3-5), 12-rule engine (Task 6), i18n en/es/pt (Task 7), Slack output
(Task 8), authenticated single daily cron route (Task 9), MCP server
(Task 10), `init` with webhook/readonly-role/cron-secret/workflow
templates/gitignore check (Task 11), `rotate` (Task 12), README/SECURITY
(Task 13). No spec section is without a task.

**Step scan / proportion:** steps carry signatures, test names and
assertions rather than full bodies, except where the spec fixes exact
values (thresholds, table names) — those are named, not re-derived.

**Type consistency:** `RuleId`/`RuleResult` defined once in Task 6 and
reused verbatim by Tasks 7-10; `track*` signatures defined once in Task 2
and reused verbatim by Tasks 3-5, 9.

**Review Focus coverage:** write failure never throws → Task 2 Step 1
first test; cron auth/duplicate guard → Task 9 Step 1; `pg_stat_statements`
permission failure isolation → Task 6 Step 1 second test; missing
`DATABASE_URL` on init → Task 11 Step 1 first test; MCP invalid-locale
rejection → Task 10 Step 1 second test. All five covered.
