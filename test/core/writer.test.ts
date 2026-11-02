import { beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import { flushForTesting, setPoolForTesting } from "../../src/core/pool.js";
import { cleanupOldRows, trackRequest } from "../../src/core/writer.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  setPoolForTesting(pool);
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
});
