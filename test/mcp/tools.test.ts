import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  resetReadonlyPoolForTesting,
  setReadonlyPoolForTesting,
  whatShouldILookAtToday,
} from "../../src/mcp/tools.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  setReadonlyPoolForTesting(pool);
  for (let i = 0; i < 60; i++) {
    await pool.query(
      `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms)
       values ('/slow', 'GET', 200, $1)`,
      [1000 + (i % 3)],
    );
  }
});

describe("whatShouldILookAtToday", () => {
  it("returns the ranked rule results with resolved messages for a given locale", async () => {
    const result = await whatShouldILookAtToday({ locale: "pt" });
    expect(result.items[0]).toHaveProperty("suggestion");
  });

  it("rejects an unsupported locale with a typed error instead of building a dynamic query", async () => {
    await expect(
      whatShouldILookAtToday({ locale: "fr" as any }),
    ).rejects.toMatchObject({ code: "invalid_locale" });
  });

  it("rejects clearly when FLUXOMETER_READONLY_URL is missing, instead of an unrelated connection error", async () => {
    resetReadonlyPoolForTesting();
    const original = process.env.FLUXOMETER_READONLY_URL;
    delete process.env.FLUXOMETER_READONLY_URL;

    try {
      await expect(whatShouldILookAtToday({})).rejects.toMatchObject({
        code: "missing_readonly_url",
      });
    } finally {
      if (original) process.env.FLUXOMETER_READONLY_URL = original;
      setReadonlyPoolForTesting(pool);
    }
  });
});
