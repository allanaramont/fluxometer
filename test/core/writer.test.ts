import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import { flushForTesting, setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  cleanupOldRows,
  resetDeployMarkerForTesting,
  trackAiCall,
  trackClientMetric,
  trackRequest,
} from "../../src/core/writer.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  await pool.query(`delete from ${SCHEMA_NAME}.client_metrics`);
  await pool.query(`delete from ${SCHEMA_NAME}.ai_calls`);
  await pool.query(`delete from ${SCHEMA_NAME}.deploy_markers`);
  setPoolForTesting(pool);
  resetDeployMarkerForTesting();
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.GITHUB_SHA;
  delete process.env.FLUXOMETER_DEPLOY_ID;
});

describe("trackRequest", () => {
  it("never throws even if the write fails", () => {
    const brokenPool = {
      query: () => Promise.reject(new Error("down")),
    } as unknown as Pool;
    setPoolForTesting(brokenPool);
    expect(() =>
      trackRequest({ route: "/x", method: "GET", status: 200, durationMs: 10 }),
    ).not.toThrow();
  });

  it("writes a row with a normalized route and no PII fields", async () => {
    trackRequest({
      route: "/tasks/:id",
      method: "GET",
      status: 200,
      durationMs: 42,
      userHash: "h1",
      platform: "web",
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select * from ${SCHEMA_NAME}.request_metrics`,
    );
    expect(rows[0]).toMatchObject({
      route: "/tasks/:id",
      duration_ms: 42,
      platform: "web",
    });
  });

  it("rounds a non-integer durationMs instead of failing the insert - duration_ms is a Postgres int column, and real timers (hrtime, performance.now) always produce fractional milliseconds", async () => {
    trackRequest({
      route: "/x",
      method: "GET",
      status: 200,
      durationMs: 8.515943,
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select duration_ms from ${SCHEMA_NAME}.request_metrics`,
    );
    expect(rows[0]).toEqual({ duration_ms: 9 });
  });
});

describe("trackClientMetric", () => {
  it("rounds a non-integer durationMs instead of failing the insert", async () => {
    trackClientMetric({
      screen: "home",
      action: "load",
      durationMs: 8.515943,
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select duration_ms from ${SCHEMA_NAME}.client_metrics`,
    );
    expect(rows[0]).toEqual({ duration_ms: 9 });
  });
});

describe("trackAiCall", () => {
  it("rounds a non-integer durationMs instead of failing the insert", async () => {
    trackAiCall({
      model: "claude",
      durationMs: 8.515943,
      success: true,
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select duration_ms from ${SCHEMA_NAME}.ai_calls`,
    );
    expect(rows[0]).toEqual({ duration_ms: 9 });
  });
});

describe("deploy marker", () => {
  it("records exactly one deploy marker per process, from a recognized CI env var", async () => {
    process.env.GITHUB_SHA = "abc123";

    trackRequest({ route: "/x", method: "GET", status: 200, durationMs: 1 });
    await flushForTesting();
    trackRequest({ route: "/y", method: "GET", status: 200, durationMs: 1 });
    await flushForTesting();

    const { rows } = await pool.query(
      `select deploy_id from ${SCHEMA_NAME}.deploy_markers`,
    );
    expect(rows).toEqual([{ deploy_id: "abc123" }]);
  });

  it("records nothing when no recognized deploy env var is set", async () => {
    trackRequest({ route: "/x", method: "GET", status: 200, durationMs: 1 });
    await flushForTesting();

    const { rows } = await pool.query(
      `select * from ${SCHEMA_NAME}.deploy_markers`,
    );
    expect(rows).toEqual([]);
  });
});

describe("cleanupOldRows", () => {
  it("deletes rows older than the cutoff and keeps recent ones", async () => {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms, created_at)
       values ('/old', 'GET', 200, 1, now() - interval '31 days')`,
    );
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms, created_at)
       values ('/new', 'GET', 200, 1, now())`,
    );

    const deleted = await cleanupOldRows(pool, 30);

    expect(deleted).toBe(1);
    const { rows } = await pool.query(
      `select route from ${SCHEMA_NAME}.request_metrics`,
    );
    expect(rows.map((r) => r.route)).toEqual(["/new"]);
  });

  it("also purges old deploy_markers rows", async () => {
    await pool.query(
      `insert into ${SCHEMA_NAME}.deploy_markers (deploy_id, created_at)
       values ('old-deploy', now() - interval '31 days')`,
    );
    await pool.query(
      `insert into ${SCHEMA_NAME}.deploy_markers (deploy_id, created_at)
       values ('new-deploy', now())`,
    );

    await cleanupOldRows(pool, 30);

    const { rows } = await pool.query(
      `select deploy_id from ${SCHEMA_NAME}.deploy_markers`,
    );
    expect(rows).toEqual([{ deploy_id: "new-deploy" }]);
  });
});
