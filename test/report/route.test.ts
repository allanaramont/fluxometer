import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPoolForTesting } from "../../src/core/pool.js";
import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import { resetHealthStateForTesting } from "../../src/report/health.js";
import {
  handleReportRequest,
  resetDuplicateGuardForTesting,
} from "../../src/report/route.js";
import * as slackSend from "../../src/report/slackSend.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  await pool.query(`delete from ${SCHEMA_NAME}.report_runs`);
  // Force the same pool the route's own getPool() would otherwise lazily
  // create from DATABASE_URL — this test must not depend on DATABASE_URL
  // happening to equal TEST_DATABASE_URL in whatever environment runs it.
  setPoolForTesting(pool);
  // The duplicate-call guard is module state (correctly so, in production)
  // — without resetting it, this test file's own earlier calls would
  // "duplicate-guard" away every later test's run.
  resetDuplicateGuardForTesting();
  resetHealthStateForTesting();
  delete process.env.CRON_SECRET;
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
    vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

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
      .mockResolvedValue();

    const failed = await handleReportRequest(req);
    expect(failed.status).toBe(500);

    const retried = await handleReportRequest(req);
    expect(retried.status).toBe(200);
    // report (rejected) → failure alert → retried report
    expect(sendSpy).toHaveBeenCalledTimes(3);
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

  it("falls back to CRON_SECRET (what Vercel Cron sends) when FLUXOMETER_CRON_SECRET isn't set", async () => {
    delete process.env.FLUXOMETER_CRON_SECRET;
    process.env.CRON_SECRET = "vercel-secret";
    vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

    const res = await handleReportRequest({
      header: (n) =>
        n.toLowerCase() === "authorization" ? "Bearer vercel-secret" : undefined,
    });

    expect(res.status).toBe(200);
  });

  it("accepts either secret when both are set with different values, so a GitHub Actions cron and a Vercel Cron can coexist", async () => {
    process.env.CRON_SECRET = "vercel-secret";
    vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

    const viaVercel = await handleReportRequest({
      header: (n) =>
        n.toLowerCase() === "authorization" ? "Bearer vercel-secret" : undefined,
    });
    resetDuplicateGuardForTesting();
    const viaGithub = await handleReportRequest({
      header: (n) => (n === "x-fluxometer-secret" ? "test-secret" : undefined),
    });

    expect(viaVercel.status).toBe(200);
    expect(viaGithub.status).toBe(200);
  });

  it("answers 503 and says exactly what's missing when no cron secret is configured at all", async () => {
    delete process.env.FLUXOMETER_CRON_SECRET;
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    const res = await handleReportRequest({
      header: (n) => (n === "x-fluxometer-secret" ? "anything" : undefined),
    });

    expect(res.status).toBe(503);
    expect(warnings).toContainEqual(
      expect.stringMatching(/not configured.*FLUXOMETER_CRON_SECRET.*CRON_SECRET/),
    );
    const { rows } = await pool.query(
      `select status, detail from ${SCHEMA_NAME}.report_runs`,
    );
    expect(rows).toEqual([{ status: "rejected", detail: "secret_not_configured" }]);
  });

  it("tells a wrong secret apart from no secret, and records the reason without ever storing the secret", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    const wrong = await handleReportRequest({
      header: (n) => (n === "x-fluxometer-secret" ? "wrong-value" : undefined),
    });
    resetHealthStateForTesting();
    const none = await handleReportRequest({ header: () => undefined });

    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(warnings[0]).toMatch(/doesn't match/);
    expect(warnings[1]).toMatch(/sent no secret/);
    expect(warnings.join(" ")).not.toContain("wrong-value");
    const { rows } = await pool.query(
      `select detail from ${SCHEMA_NAME}.report_runs order by id`,
    );
    expect(rows.map((r) => r.detail)).toEqual([
      "secret_mismatch",
      "no_secret_sent",
    ]);
  });

  it("records a successful run, and on failure records it, alerts Slack, and never leaks a connection string", async () => {
    const req = {
      header: (n: string) =>
        n === "x-fluxometer-secret" ? "test-secret" : undefined,
    };
    const sendSpy = vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

    expect((await handleReportRequest(req)).status).toBe(200);

    resetDuplicateGuardForTesting();
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendSpy
      .mockRejectedValueOnce(
        new Error("connect failed for postgres://user:pw@db.example.com/app"),
      )
      .mockResolvedValue();
    expect((await handleReportRequest(req)).status).toBe(500);

    const { rows } = await pool.query(
      `select status, detail from ${SCHEMA_NAME}.report_runs order by id`,
    );
    expect(rows.map((r) => r.status)).toEqual(["ok", "failed"]);
    expect(rows[1].detail).toContain("<redacted-url>");
    expect(rows[1].detail).not.toContain("pw@");

    const alert = sendSpy.mock.calls.at(-1)?.[1] ?? "";
    expect(alert).toMatch(/report failed/);
    expect(alert).not.toContain("pw@");
  });
});
