import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { migrate } from "../src/migrate.js";

describe("migrate", () => {
  it("runs the schema migration using DATABASE_URL and closes its own pool", async () => {
    await migrate(process.env.TEST_DATABASE_URL);

    const verifyPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    try {
      const { rows } = await verifyPool.query(
        `select table_name from information_schema.tables where table_schema = 'fluxometer'`,
      );
      expect(rows.map((r) => r.table_name).sort()).toEqual([
        "ai_calls",
        "client_metrics",
        "deploy_markers",
        "report_runs",
        "request_metrics",
      ]);
    } finally {
      await verifyPool.end();
    }
  });

  it("throws a clear error instead of connecting with pg's OS-user fallback when no connection string is available", async () => {
    await expect(migrate("")).rejects.toThrow(/DATABASE_URL/);
  });
});
