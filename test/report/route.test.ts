import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  handleReportRequest,
  resetDuplicateGuardForTesting,
} from "../../src/report/route.js";
import * as slackSend from "../../src/report/slackSend.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  // Force the same pool the route's own getPool() would otherwise lazily
  // create from DATABASE_URL — this test must not depend on DATABASE_URL
  // happening to equal TEST_DATABASE_URL in whatever environment runs it.
  setPoolForTesting(pool);
  // The duplicate-call guard is module state (correctly so, in production)
  // — without resetting it, this test file's own earlier calls would
  // "duplicate-guard" away every later test's run.
  resetDuplicateGuardForTesting();
  process.env.FLUXOMETER_CRON_SECRET = "test-secret";
  process.env.FLUXOMETER_SLACK_WEBHOOK_URL =
    "https://hooks.slack.com/services/x";
});

describe("handleReportRequest", () => {
  it("rejects with 401 when the secret header is missing or wrong", async () => {
    const res = await handleReportRequest({ header: () => undefined });
    expect(res.status).toBe(401);
  });

  it("also accepts the secret via Authorization: Bearer — Vercel Cron cannot set a custom header", async () => {
    const req = {
      header: (n: string) =>
        n.toLowerCase() === "authorization"
          ? `Bearer ${process.env.FLUXOMETER_CRON_SECRET}`
          : undefined,
    };

    const res = await handleReportRequest(req);

    expect(res.status).toBe(200);
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

  it("returns 500 (never a false 200) when sending to Slack fails, and allows an immediate retry instead of treating the failed attempt as the duplicate-guard window", async () => {
    const req = {
      header: (n: string) =>
        n === "x-fluxometer-secret"
          ? process.env.FLUXOMETER_CRON_SECRET
          : undefined,
    };
    const sendSpy = vi
      .spyOn(slackSend, "postToSlack")
      .mockRejectedValueOnce(
        new Error("Slack webhook rejected the report (404)"),
      )
      .mockResolvedValueOnce();

    const failed = await handleReportRequest(req);
    expect(failed.status).toBe(500);

    const retried = await handleReportRequest(req);
    expect(retried.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("warns (never silently) when no Slack webhook is configured, but still computes and returns success", async () => {
    delete process.env.FLUXOMETER_SLACK_WEBHOOK_URL;
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const req = {
      header: (n: string) =>
        n === "x-fluxometer-secret"
          ? process.env.FLUXOMETER_CRON_SECRET
          : undefined,
    };

    const res = await handleReportRequest(req);

    expect(res.status).toBe(200);
    expect(warnings).toContainEqual(expect.stringMatching(/webhook/i));
  });
});
