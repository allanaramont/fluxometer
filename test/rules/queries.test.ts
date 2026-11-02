import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  errorSpike,
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
