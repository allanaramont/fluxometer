import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { runMigration } from "../../src/core/schema.js";

describe("runMigration", () => {
  it("creates the fluxometer schema and its four tables idempotently", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await runMigration(pool);
      await runMigration(pool); // second call must not throw
      const { rows } = await pool.query(
        `select table_name from information_schema.tables where table_schema = 'fluxometer'`,
      );
      expect(rows.map((r) => r.table_name).sort()).toEqual([
        "ai_calls",
        "client_metrics",
        "deploy_markers",
        "request_metrics",
      ]);
    } finally {
      await pool.end();
    }
  });
});
