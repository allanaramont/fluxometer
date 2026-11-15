import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { flushForTesting, setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import { trackAudit, trackClientMetric } from "../../src/core/writer.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

const inserts = (spy: { mock: { calls: unknown[][] } }, table: string) =>
  spy.mock.calls.filter(([sql]) => String(sql).includes(`${SCHEMA_NAME}.${table}`));

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.audit_events`);
  await pool.query(`delete from ${SCHEMA_NAME}.client_metrics`);
  setPoolForTesting(pool);
});

describe("audit events are written in batches", () => {
  it("writes a burst enqueued in one tick as a single multi-row INSERT", async () => {
    const query = vi.spyOn(pool, "query");
    for (let i = 0; i < 50; i++) {
      trackAudit({
        entity: "Pet",
        action: "update",
        targetId: `p${i}`,
        fields: ["name"],
        tags: i % 2 ? ["a", "b"] : undefined,
      });
    }
    await flushForTesting();
    expect(inserts(query, "audit_events")).toHaveLength(1);
    const { rows } = await pool.query(
      `select target_id, fields, tags from ${SCHEMA_NAME}.audit_events order by id`,
    );
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({ target_id: "p0", fields: ["name"], tags: null });
    expect(rows[1].tags).toEqual(["a", "b"]);
  });

  it("splits a very large burst into bounded INSERTs", async () => {
    const query = vi.spyOn(pool, "query");
    for (let i = 0; i < 450; i++) trackAudit({ entity: "E", action: "a" });
    await flushForTesting();
    expect(inserts(query, "audit_events")).toHaveLength(3); // 200 + 200 + 50
    const { rows } = await pool.query(
      `select count(*)::int as n from ${SCHEMA_NAME}.audit_events`,
    );
    expect(rows[0].n).toBe(450);
  });

  it("drops (and says so) instead of growing without bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 5100; i++) trackAudit({ entity: "E", action: "a" });
    await flushForTesting();
    const { rows } = await pool.query(
      `select count(*)::int as n from ${SCHEMA_NAME}.audit_events`,
    );
    expect(rows[0].n).toBe(5000);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /dropped 100 audit_events row/,
    );
  });

  it("never throws and keeps working after a failed write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setPoolForTesting({
      query: () => Promise.reject(new Error("down")),
    } as unknown as Pool);
    expect(() => trackAudit({ entity: "E", action: "a" })).not.toThrow();
    await flushForTesting();
    setPoolForTesting(pool);
    trackAudit({ entity: "After", action: "a" });
    await flushForTesting();
    const { rows } = await pool.query(
      `select entity from ${SCHEMA_NAME}.audit_events`,
    );
    expect(rows.map((r) => r.entity)).toEqual(["After"]);
  });
});

describe("client metrics are written in batches", () => {
  it("writes a burst as one INSERT with every value in place", async () => {
    const query = vi.spyOn(pool, "query");
    for (let i = 0; i < 30; i++) {
      trackClientMetric({
        screen: "api",
        action: `GET /x${i}`,
        durationMs: 10.6 + i,
        appVersion: i === 0 ? "1.0.0+1" : undefined,
        platform: "ios",
      });
    }
    await flushForTesting();
    expect(inserts(query, "client_metrics")).toHaveLength(1);
    const { rows } = await pool.query(
      `select action, duration_ms, app_version from ${SCHEMA_NAME}.client_metrics order by id`,
    );
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({ action: "GET /x0", duration_ms: 11, app_version: "1.0.0+1" });
    expect(rows[1].app_version).toBeNull();
  });
});
