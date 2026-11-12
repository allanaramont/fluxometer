import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  errorSpike,
  isAppQuery,
  normalizeQueryText,
  peakHourBottleneck,
  platformErrorConcentration,
  slowQuery,
  timeoutSpike,
  topConsumer,
} from "../../src/rules/queries.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

async function seed(
  route: string,
  count: number,
  opts: { status?: number; platform?: string; createdAt?: string } = {},
): Promise<void> {
  const status = opts.status ?? 200;
  const platform = opts.platform ?? null;
  const createdAt = opts.createdAt ?? "now()";
  for (let i = 0; i < count; i++) {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms, platform, created_at)
       values ($1, 'GET', $2, 10, $3, ${createdAt})`,
      [route, status, platform],
    );
  }
}

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
});

describe("platformErrorConcentration", () => {
  it("flags the worse of exactly two platforms (the common web-vs-ios case)", async () => {
    // web: 100 reqs, 0 errors. ios: 100 reqs, 30 errors (30%) — with only
    // two samples, mean+stdev of [0, 0.3] equals 0.3 exactly, so a naive
    // `> mean + stdev` filter can never fire here.
    await seed("/sync", 100, { platform: "web" });
    await seed("/sync", 70, { platform: "ios" });
    await seed("/sync", 30, { platform: "ios", status: 500 });

    const results = await platformErrorConcentration(pool);

    expect(results.some((r) => r.subject === "ios")).toBe(true);
  });

  it("does not flag platforms with similar, low error rates", async () => {
    await seed("/sync", 100, { platform: "web" });
    await seed("/sync", 99, { platform: "ios" });
    await seed("/sync", 1, { platform: "ios", status: 500 });

    const results = await platformErrorConcentration(pool);

    expect(results).toEqual([]);
  });
});

describe("errorSpike", () => {
  it("detects a spike confined to a past hour within the 24h window, not just the last hour", async () => {
    // A 2-hour-old spike: outside any "last 1 hour" window, but still
    // inside the 24h lookback the single daily cron run has to cover.
    await seed("/api", 50, {
      status: 500,
      createdAt: "now() - interval '2 hours'",
    });
    await seed("/api", 50, { createdAt: "now() - interval '2 hours'" });
    // The current hour is clean.
    await seed("/api", 50);

    const results = await errorSpike(pool);

    expect(results.some((r) => r.subject === "/api")).toBe(true);
  });

  it("uses English metric key names — this is an en-default public package, not a pt/en mix", async () => {
    await seed("/api", 50, { status: 500 });

    const results = await errorSpike(pool);

    expect(results[0]?.metrics).toHaveProperty("errorRate");
    expect(results[0]?.metrics).not.toHaveProperty("taxaErro");
  });
});

describe("timeoutSpike", () => {
  it("detects a timeout spike confined to a past hour within the 24h window", async () => {
    await seed("/api", 50, {
      status: 504,
      createdAt: "now() - interval '3 hours'",
    });
    await seed("/api", 50, { createdAt: "now() - interval '3 hours'" });

    const results = await timeoutSpike(pool);

    expect(results.some((r) => r.subject === "/api")).toBe(true);
  });
});

describe("topConsumer", () => {
  it("reports nothing on a healthy day with only trivial traffic, instead of forcing the top 3 regardless of volume", async () => {
    // A handful of fast, low-volume requests — nothing worth reporting.
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms)
       select '/ping', 'GET', 200, 5 from generate_series(1, 5)`,
    );

    const results = await topConsumer(pool);

    expect(results).toEqual([]);
  });

  it("still reports genuine top consumers with real volume and time", async () => {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms)
       select '/heavy', 'GET', 200, 500 from generate_series(1, 200)`,
    );

    const results = await topConsumer(pool);

    expect(results.some((r) => r.subject === "/heavy")).toBe(true);
  });
});

describe("slowQuery", () => {
  it("excludes statements that look like they carry a password, and scopes to the current database", async () => {
    // pg_stat_statements may not be installed locally at all, so this
    // asserts the SQL fluxometer sends rather than depending on the
    // extension or on CREATE/ALTER ROLE actually showing up in it.
    const querySpy = vi
      .spyOn(pool, "query")
      .mockResolvedValue({ rows: [] } as never);

    await slowQuery(pool);

    const sql = String(querySpy.mock.calls[0]?.[0]);
    expect(sql).toMatch(/not ilike '%password%'/i);
    expect(sql).toMatch(/current_database/i);
  });
});

describe("slowQuery filtering (what the report showed on a real Supabase project)", () => {
  const rows = [
    // Real noise from production pg_stat_statements:
    { query: "-- postgres-migrations disable-transaction\n-- Create index for case-insensitive search\ncreate index concurrently if not exists x on t (lower(name))", mean_exec_time: 618.56, calls: 40 },
    { query: 'COPY public."Event" (id, "familyId", title) TO stdout', mean_exec_time: 494.5, calls: 30 },
    { query: "with page as (select c.oid, c.relname, c.reltuples from pg_class c join pg_namespace n on n.oid = c.relnamespace) select * from page", mean_exec_time: 415.3, calls: 300 },
    { query: "-- Partial unique index scoped to AI_UPGRADE_REQUEST only.\nCREATE UNIQUE INDEX ...", mean_exec_time: 403.9, calls: 25 },
    { query: "SELECT e.name, n.nspname AS schema, e.default_version, x.extversion FROM pg_available_extensions e", mean_exec_time: 394.6, calls: 80 },
    { query: 'select * from "auth"."users" where id = $1', mean_exec_time: 300, calls: 900 },
    { query: "select count(*) from fluxometer.request_metrics where created_at > now() - interval '24 hours'", mean_exec_time: 250, calls: 60 },
    // The app's own repeated queries — these should be reported:
    { query: 'SELECT "public"."Task"."id", "public"."Task"."title" FROM "public"."Task" WHERE "public"."Task"."familyId" = $1 ORDER BY "public"."Task"."dueDate" ASC', mean_exec_time: 380.123456, calls: 1200 },
    { query: "/* prisma */ select * from \"Event\" where \"familyId\" = $1", mean_exec_time: 220.9, calls: 55 },
  ];

  it("keeps only the app's own data access and drops migrations, backups, dashboards and platform schemas", async () => {
    const querySpy = vi
      .spyOn(pool, "query")
      .mockResolvedValue({ rows } as never);

    const results = await slowQuery(pool);

    expect(results.map((r) => r.metrics.meanExecMs)).toEqual([380, 221]);
    expect(results[0].subject).toMatch(/^SELECT "public"."Task"/);
    expect(results[0].subject.length).toBeLessThanOrEqual(101);
    expect(results[1].subject).toBe('select * from "Event" where "familyId" = $1');
    const sql = String(querySpy.mock.calls[0]?.[0]);
    expect(sql).toMatch(/calls >= \$3/);
    expect(sql).toMatch(/rolname = any\(\$1\)/);
  });

  it("normalizes comments and whitespace before deciding", () => {
    expect(normalizeQueryText("-- a\n  /* b */ select\n  1")).toBe("select 1");
    expect(isAppQuery("select * from orders where id = $1")).toBe(true);
    expect(isAppQuery("SET statement_timeout = 0")).toBe(false);
    expect(isAppQuery("select * from information_schema.columns")).toBe(false);
    expect(isAppQuery("select * from storage.objects")).toBe(false);
  });

  it("runs against a real pg_stat_statements without errors, when the extension is available", async () => {
    const { rows: ext } = await pool.query(
      "select 1 from pg_extension where extname = 'pg_stat_statements'",
    );
    if (ext.length === 0) return; // not installed in this database (e.g. CI)
    await expect(slowQuery(pool)).resolves.toBeInstanceOf(Array);
  });
});

describe("peakHourBottleneck", () => {
  beforeEach(async () => {
    await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
    delete process.env.FLUXOMETER_TIMEZONE;
  });

  async function seedAtUtcHour(hour: number, durationMs: number, n: number) {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms, created_at)
       select '/mcp', 'POST', 200, $2, (date_trunc('day', (now() - interval '1 day') at time zone 'UTC') + ($1::int * interval '1 hour')) at time zone 'UTC'
       from generate_series(1, $3)`,
      [hour, durationMs, n],
    );
  }

  it("reports the hour in FLUXOMETER_TIMEZONE, and rounds the numbers", async () => {
    await seedAtUtcHour(20, 1160, 25);
    await seedAtUtcHour(10, 101, 25);
    await seedAtUtcHour(12, 103, 25);
    await seedAtUtcHour(14, 100, 25);

    const utc = await peakHourBottleneck(pool);
    process.env.FLUXOMETER_TIMEZONE = "America/Sao_Paulo";
    const local = await peakHourBottleneck(pool);

    expect(utc[0].metrics).toMatchObject({ hourOfDay: 20, timeZone: "UTC" });
    expect(local[0].metrics).toMatchObject({
      hourOfDay: 17,
      timeZone: "America/Sao_Paulo",
      p95: 1160,
    });
    expect(Number.isInteger(local[0].metrics.avgP95)).toBe(true);
  });

  it("falls back to UTC on an invalid time zone instead of failing the report", async () => {
    process.env.FLUXOMETER_TIMEZONE = "Not/AZone";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedAtUtcHour(20, 1160, 25);
    await seedAtUtcHour(10, 100, 25);
    await expect(peakHourBottleneck(pool)).resolves.toBeInstanceOf(Array);
  });
});
