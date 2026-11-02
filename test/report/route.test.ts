import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import * as slackSend from "../../src/report/slackSend.js";
import { handleReportRequest } from "../../src/report/route.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  process.env.FLUXOMETER_CRON_SECRET = "test-secret";
  process.env.FLUXOMETER_SLACK_WEBHOOK_URL =
    "https://hooks.slack.com/services/x";
});

describe("handleReportRequest", () => {
  it("rejects with 401 when the secret header is missing or wrong", async () => {
    const res = await handleReportRequest({ header: () => undefined });
    expect(res.status).toBe(401);
  });

  it("runs the engine and sends to Slack exactly once for a valid request, and ignores an identical duplicate within the guard window", async () => {
    const req = {
      header: (n: string) =>
        n === "x-fluxometer-secret"
          ? process.env.FLUXOMETER_CRON_SECRET
          : undefined,
    };
    const sendSpy = vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

    await handleReportRequest(req);
    await handleReportRequest(req); // duplicate within the window

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
