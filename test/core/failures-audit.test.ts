import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import { flushForTesting, setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  cleanupOldRows,
  trackAudit,
  trackFailure,
} from "../../src/core/writer.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_failures`);
  await pool.query(`delete from ${SCHEMA_NAME}.audit_events`);
  setPoolForTesting(pool);
});

describe("trackFailure", () => {
  it("never throws even if the write fails", () => {
    setPoolForTesting({
      query: () => Promise.reject(new Error("down")),
    } as unknown as Pool);
    expect(() =>
      trackFailure({ route: "/x", method: "GET", status: 500 }),
    ).not.toThrow();
  });

  it("stores the failure with its cause, rounding the duration", async () => {
    trackFailure({
      route: "/pets/:petId",
      method: "PUT",
      status: 403,
      durationMs: 41.6,
      errorName: "AppError",
      errorCode: "FORBIDDEN",
      message: "You are not a member of this family",
      correlationId: "corr-1",
      tenant: "family-1",
      userHash: "h1",
      platform: "ios",
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select * from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: "/pets/:petId",
      method: "PUT",
      status: 403,
      duration_ms: 42,
      error_name: "AppError",
      error_code: "FORBIDDEN",
      message: "You are not a member of this family",
      correlation_id: "corr-1",
      tenant: "family-1",
      user_hash: "h1",
      platform: "ios",
    });
  });

  it("sanitizes the message on every path - no caller can store raw text", async () => {
    trackFailure({
      route: "/x",
      method: "POST",
      status: 400,
      message: "Invalid for ana@example.com, cpf 123.456.789-09, ?token=abc",
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select message from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows[0].message).not.toMatch(/ana@example\.com|123\.456|token=abc/);
    expect(rows[0].message).toContain("[email]");
  });

  it("allows a failure with no cause at all", async () => {
    trackFailure({ route: "/x", method: "GET", status: 401 });
    await flushForTesting();
    const { rows } = await pool.query(
      `select error_name, error_code, message, duration_ms from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows[0]).toEqual({
      error_name: null,
      error_code: null,
      message: null,
      duration_ms: null,
    });
  });
});

describe("trackAudit", () => {
  it("never throws even if the write fails", () => {
    setPoolForTesting({
      query: () => Promise.reject(new Error("down")),
    } as unknown as Pool);
    expect(() => trackAudit({ entity: "Pet", action: "update" })).not.toThrow();
  });

  it("stores who/what/where and the NAMES of what changed", async () => {
    trackAudit({
      entity: "Pet",
      action: "update",
      targetId: "p1",
      affectedCount: 1,
      tenant: "family-1",
      actor: "u1",
      source: "http",
      route: "/api/pets/:petId",
      method: "PUT",
      correlationId: "corr-1",
      fields: ["name", "weight"],
      effect: "scoped",
      tags: ["pets-list", "agenda-day"],
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select * from ${SCHEMA_NAME}.audit_events`,
    );
    expect(rows[0]).toMatchObject({
      entity: "Pet",
      action: "update",
      target_id: "p1",
      affected_count: 1,
      tenant: "family-1",
      actor: "u1",
      source: "http",
      route: "/api/pets/:petId",
      method: "PUT",
      correlation_id: "corr-1",
      fields: ["name", "weight"],
      effect: "scoped",
      tags: ["pets-list", "agenda-day"],
    });
  });

  it("bounds a wide or odd event instead of failing the insert", async () => {
    trackAudit({
      entity: "X".repeat(300),
      action: "",
      fields: Array.from({ length: 90 }, (_, i) => `f${i}`),
      affectedCount: Number.NaN,
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select entity, action, affected_count, fields from ${SCHEMA_NAME}.audit_events`,
    );
    expect(rows[0].entity).toHaveLength(64);
    expect(rows[0].action).toBe("unknown");
    expect(rows[0].affected_count).toBeNull();
    expect(rows[0].fields).toHaveLength(50);
  });
});

describe("cleanupOldRows covers the new tables", () => {
  it("deletes failures and audit events older than the retention", async () => {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_failures (route, method, status, created_at)
       values ('/old','GET',500, now() - interval '40 days'), ('/new','GET',500, now())`,
    );
    await pool.query(
      `insert into ${SCHEMA_NAME}.audit_events (entity, action, created_at)
       values ('Old','x', now() - interval '40 days'), ('New','x', now())`,
    );
    await cleanupOldRows(pool, 30);
    const failures = await pool.query(
      `select route from ${SCHEMA_NAME}.request_failures`,
    );
    const events = await pool.query(
      `select entity from ${SCHEMA_NAME}.audit_events`,
    );
    expect(failures.rows.map((r) => r.route)).toEqual(["/new"]);
    expect(events.rows.map((r) => r.entity)).toEqual(["New"]);
  });
});
