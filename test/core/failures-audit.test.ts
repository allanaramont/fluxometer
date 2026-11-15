import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { flushForTesting, setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  cleanupOldRows,
  resetFailureLimiterForTesting,
  trackAudit,
  trackFailure,
} from "../../src/core/writer.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_failures`);
  await pool.query(`delete from ${SCHEMA_NAME}.audit_events`);
  setPoolForTesting(pool);
  resetFailureLimiterForTesting();
  delete process.env.FLUXOMETER_FAILURES_PER_MINUTE;
});

describe("trackFailure rate limit", () => {
  it("drops failure rows over the per-minute cap instead of flooding the pool", async () => {
    process.env.FLUXOMETER_FAILURES_PER_MINUTE = "5";
    for (let i = 0; i < 50; i++) {
      trackFailure({ route: "/login", method: "POST", status: 401 });
    }
    await flushForTesting();
    const { rows } = await pool.query(
      `select count(*)::int as n from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows[0].n).toBe(5);
  });

  it("caps each kind of failure separately, so one flood cannot hide another", async () => {
    process.env.FLUXOMETER_FAILURES_PER_KEY_PER_MINUTE = "3";
    for (let i = 0; i < 100; i++) {
      trackFailure({ route: "/login", method: "POST", status: 401 });
    }
    trackFailure({ route: "/pets/:id", method: "GET", status: 500 });
    trackFailure({ route: "/pets/:id", method: "GET", status: 500, errorCode: "DB_DOWN" });
    await flushForTesting();
    delete process.env.FLUXOMETER_FAILURES_PER_KEY_PER_MINUTE;
    const { rows } = await pool.query(
      `select route, status, error_code, count(*)::int as n
         from ${SCHEMA_NAME}.request_failures
        group by route, status, error_code order by route, error_code nulls first`,
    );
    expect(rows).toEqual([
      { route: "/login", status: 401, error_code: null, n: 3 },
      { route: "/pets/:id", status: 500, error_code: null, n: 1 },
      { route: "/pets/:id", status: 500, error_code: "DB_DOWN", n: 1 },
    ]);
  });

  it("logs what it dropped, with the noisiest kinds, when the window rolls over", async () => {
    process.env.FLUXOMETER_FAILURES_PER_KEY_PER_MINUTE = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realNow = Date.now;
    try {
      let now = 5_000_000;
      Date.now = () => now;
      for (let i = 0; i < 4; i++) {
        trackFailure({ route: "/login", method: "POST", status: 401 });
      }
      now += 61_000;
      trackFailure({ route: "/login", method: "POST", status: 401 });
    } finally {
      Date.now = realNow;
    }
    await flushForTesting();
    delete process.env.FLUXOMETER_FAILURES_PER_KEY_PER_MINUTE;
    const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toMatch(/dropped 3 failure row/);
    expect(message).toContain("/login|401");
  });

  it("admits again in the next window", async () => {
    process.env.FLUXOMETER_FAILURES_PER_MINUTE = "2";
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      for (let i = 0; i < 5; i++) {
        trackFailure({ route: "/a", method: "GET", status: 500 });
      }
      now += 61_000;
      for (let i = 0; i < 5; i++) {
        trackFailure({ route: "/b", method: "GET", status: 500 });
      }
    } finally {
      Date.now = realNow;
    }
    await flushForTesting();
    const { rows } = await pool.query(
      `select route, count(*)::int as n from ${SCHEMA_NAME}.request_failures group by route order by route`,
    );
    expect(rows).toEqual([
      { route: "/a", n: 2 },
      { route: "/b", n: 2 },
    ]);
  });
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

  it("stores a numeric error code and redacts an e-mail passed as a label", async () => {
    trackFailure({
      route: "/x",
      method: "POST",
      status: 409,
      errorCode: 11000,
      errorName: "User ana@example.com missing",
      tenant: "ana@example.com",
    });
    await flushForTesting();
    const { rows } = await pool.query(
      `select error_code, error_name, tenant from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows[0].error_code).toBe("11000");
    expect(rows[0].error_name).not.toContain("ana@example.com");
    expect(rows[0].tenant).toBe("[email]");
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

  it("clamps an affectedCount beyond int4 instead of losing the row", async () => {
    trackAudit({ entity: "Task", action: "updateMany", affectedCount: 1e10 });
    await flushForTesting();
    const { rows } = await pool.query(
      `select affected_count from ${SCHEMA_NAME}.audit_events`,
    );
    expect(rows[0].affected_count).toBe(2_147_483_647);
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
