import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import {
  expressMiddleware,
  setFailureCause,
} from "../../src/adapters/express.js";
import { flushForTesting, setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import { resetFailureLimiterForTesting } from "../../src/core/writer.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_failures`);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  setPoolForTesting(pool);
  resetFailureLimiterForTesting();
});

// The path that matters for privacy: middleware -> writer -> database.
describe("express failures end to end", () => {
  it("stores a captured message already sanitized", async () => {
    const app = express();
    app.use(expressMiddleware({ failures: { captureMessage: true } }));
    app.get("/x", (_req, res) => {
      setFailureCause(res, {
        name: "AppError",
        code: "BAD_INPUT",
        message: "Invalid for ana@example.com password=hunter2 from 10.0.0.9",
      });
      res.status(400).send("bad");
    });
    await request(app).get("/x");
    await new Promise((resolve) => setImmediate(resolve));
    await flushForTesting();
    const { rows } = await pool.query(
      `select * from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).not.toMatch(/ana@example\.com|hunter2|10\.0\.0\.9/);
    expect(rows[0]).toMatchObject({ route: "/x", status: 400, error_code: "BAD_INPUT" });
  });

  it("stores no message at all by default, even if the handler passes one", async () => {
    const app = express();
    app.use(expressMiddleware());
    app.get("/x", (_req, res) => {
      setFailureCause(res, { name: "AppError", message: "secret detail" });
      res.status(500).send("boom");
    });
    await request(app).get("/x");
    await new Promise((resolve) => setImmediate(resolve));
    await flushForTesting();
    const { rows } = await pool.query(
      `select message from ${SCHEMA_NAME}.request_failures`,
    );
    expect(rows[0].message).toBeNull();
  });
});
