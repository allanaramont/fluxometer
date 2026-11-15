import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  recentAuditEvents,
  recentFailures,
  resetReadonlyPoolForTesting,
  setReadonlyPoolForTesting,
} from "../../src/mcp/tools.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_failures`);
  await pool.query(`delete from ${SCHEMA_NAME}.audit_events`);
  setReadonlyPoolForTesting(pool);
});

describe("recentFailures", () => {
  it("groups failures by route, status and cause, most frequent first", async () => {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `insert into ${SCHEMA_NAME}.request_failures (route, method, status, error_name, error_code)
         values ('/a', 'GET', 403, 'AppError', 'FORBIDDEN')`,
      );
    }
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_failures (route, method, status) values ('/b', 'GET', 500)`,
    );
    const result = await recentFailures({});
    expect(result.total).toBe(4);
    expect(result.groups[0]).toMatchObject({
      route: "/a",
      status: 403,
      errorName: "AppError",
      errorCode: "FORBIDDEN",
      count: 3,
    });
    expect(result.groups[1]).toMatchObject({ route: "/b", count: 1, errorCode: null });
  });

  it("reports the real window total even when more groups exist than the limit", async () => {
    for (let i = 0; i < 6; i++) {
      await pool.query(
        `insert into ${SCHEMA_NAME}.request_failures (route, method, status) values ($1, 'GET', 500), ($1, 'GET', 500)`,
        [`/r${i}`],
      );
    }
    const result = await recentFailures({ limit: 2 });
    expect(result.groups).toHaveLength(2);
    expect(result.total).toBe(12);
  });

  it("returns a zero total for an empty window", async () => {
    expect((await recentFailures({})).total).toBe(0);
  });

  it("only looks at the requested window and bounds its inputs", async () => {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_failures (route, method, status, created_at)
       values ('/old','GET',500, now() - interval '3 days'), ('/new','GET',500, now())`,
    );
    const day = await recentFailures({ hours: 24 });
    expect(day.groups.map((g) => g.route)).toEqual(["/new"]);
    const huge = await recentFailures({ hours: 999999, limit: 99999 });
    expect(huge.windowHours).toBe(720);
  });
});

describe("recentAuditEvents", () => {
  async function seed() {
    await pool.query(
      `insert into ${SCHEMA_NAME}.audit_events (entity, action, tenant, effect, fields, tags, created_at)
       values ('Pet','update','f1','scoped', array['name'], array['pets-list'], now() - interval '2 hours'),
              ('Task','updateMany',null,'wide', array['status'], array['board'], now() - interval '1 hour'),
              ('Pet','create','f2','none', array['name','weight'], null, now())`,
    );
  }

  it("returns the newest events first with their field names", async () => {
    await seed();
    const { events } = await recentAuditEvents({});
    expect(events.map((e) => `${e.entity}:${e.action}`)).toEqual([
      "Pet:create",
      "Task:updateMany",
      "Pet:update",
    ]);
    expect(events[0].fields).toEqual(["name", "weight"]);
    expect(events[0].tags).toEqual([]);
  });

  it("hides actor and targetId unless personal ids are asked for", async () => {
    await pool.query(
      `insert into ${SCHEMA_NAME}.audit_events (entity, action, actor, target_id, tenant)
       values ('Pet','update','user-1','pet-9','f1')`,
    );
    const hidden = (await recentAuditEvents({})).events[0];
    expect(hidden.actor).toBeNull();
    expect(hidden.targetId).toBeNull();
    expect(hidden.tenant).toBe("f1");
    const shown = (await recentAuditEvents({ includePersonalIds: true })).events[0];
    expect(shown.actor).toBe("user-1");
    expect(shown.targetId).toBe("pet-9");
  });

  it("filters by entity, effect and tenant", async () => {
    await seed();
    expect((await recentAuditEvents({ effect: "wide" })).events).toHaveLength(1);
    expect((await recentAuditEvents({ entity: "Pet" })).events).toHaveLength(2);
    expect((await recentAuditEvents({ tenant: "f2" })).events).toHaveLength(1);
  });

  it("limits the number of rows", async () => {
    await seed();
    expect((await recentAuditEvents({ limit: 2 })).events).toHaveLength(2);
  });
});

describe("read-only pool reset", () => {
  it("keeps the helper importable for other suites", () => {
    expect(typeof resetReadonlyPoolForTesting).toBe("function");
  });
});
