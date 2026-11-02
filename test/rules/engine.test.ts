import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import { rank, runEngine } from "../../src/rules/engine.js";
import type { RuleResult } from "../../src/rules/queries.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

async function seedRequests(
  route: string,
  count: number,
  durationMs: number,
  opts: { status?: number; platform?: string; createdAt?: string } = {},
): Promise<void> {
  const status = opts.status ?? 200;
  const platform = opts.platform ?? null;
  const createdAt = opts.createdAt ?? "now()";
  for (let i = 0; i < count; i++) {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms, platform, created_at)
       values ($1, 'GET', $2, $3, $4, ${createdAt})`,
      [route, status, durationMs + (i % 3), platform],
    );
  }
}

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  await pool.query(`delete from ${SCHEMA_NAME}.ai_calls`);
  await pool.query(`delete from ${SCHEMA_NAME}.deploy_markers`);
});

describe("runEngine", () => {
  it("flags a route as slow_route when p95 exceeds the threshold with enough volume, and ranks it before a route with less total time", async () => {
    await seedRequests("/slow", 60, 1000);
    await seedRequests("/fast", 60, 50);

    const results = await runEngine(pool);

    expect(results[0]).toMatchObject({
      ruleId: "slow_route",
      subject: "/slow",
    });
  });

  it("disables only slow_query when pg_stat_statements is unreadable, and still returns the other rules", async () => {
    await seedRequests("/slow", 60, 1000);
    await seedRequests("/fast", 60, 50);
    const realQuery = pool.query.bind(pool);
    vi.spyOn(pool, "query").mockImplementation(((
      sql: string,
      ...rest: unknown[]
    ) =>
      typeof sql === "string" && sql.includes("pg_stat_statements")
        ? Promise.reject(new Error("permission denied"))
        : (realQuery as (...a: unknown[]) => unknown)(
            sql,
            ...rest,
          )) as typeof pool.query);

    const results = await runEngine(pool);

    expect(results.some((r) => r.ruleId === "slow_query")).toBe(false);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("rank", () => {
  it("ranks a live error spike above a chronically slow route of the same severity, even though the slow route's own metric is numerically much larger", () => {
    const slowRouteResult: RuleResult = {
      ruleId: "slow_route",
      severity: "high",
      subject: "/slow",
      metrics: { tempoTotalMs: 5_000_000, p95: 1500, reqs: 5000 },
    };
    const errorSpikeResult: RuleResult = {
      ruleId: "error_spike",
      severity: "high",
      subject: "/checkout",
      metrics: { taxaErro: 0.5, reqs: 12 },
    };

    const results = rank([slowRouteResult, errorSpikeResult]);

    expect(results[0]?.ruleId).toBe("error_spike");
  });
});
