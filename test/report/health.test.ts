import { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMigration, SCHEMA_NAME } from "../../src/core/schema.js";
import {
  checkReportHealth,
  describeStaleCause,
  formatStaleAlert,
  resetHealthStateForTesting,
  runStaleReportWatchdog,
  sanitizeErrorDetail,
} from "../../src/report/health.js";
import * as slackSend from "../../src/report/slackSend.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

async function metricHoursAgo(hours: number): Promise<void> {
  await pool.query(
    `insert into ${SCHEMA_NAME}.request_metrics (route, method, status, duration_ms, created_at)
     values ('/x', 'GET', 200, 10, now() - ($1::int * interval '1 hour'))`,
    [hours],
  );
}

async function runHoursAgo(
  hours: number,
  status: string,
  detail: string | null = null,
): Promise<void> {
  await pool.query(
    `insert into ${SCHEMA_NAME}.report_runs (status, detail, created_at)
     values ($1, $2, now() - ($3::int * interval '1 hour'))`,
    [status, detail, hours],
  );
}

beforeEach(async () => {
  await runMigration(pool);
  await pool.query(`delete from ${SCHEMA_NAME}.request_metrics`);
  await pool.query(`delete from ${SCHEMA_NAME}.report_runs`);
  resetHealthStateForTesting();
  delete process.env.CRON_SECRET;
  process.env.FLUXOMETER_CRON_SECRET = "test-secret";
  process.env.FLUXOMETER_SLACK_WEBHOOK_URL =
    "https://hooks.slack.com/services/x";
  delete process.env.FLUXOMETER_LOCALE;
});

describe("checkReportHealth", () => {
  it("is healthy on a fresh install that hasn't reached its first cron run yet", async () => {
    await metricHoursAgo(3);
    expect(await checkReportHealth(pool)).toEqual({ stale: false });
  });

  it("is healthy when the last successful report is recent", async () => {
    await metricHoursAgo(100);
    await runHoursAgo(20, "ok");
    expect(await checkReportHealth(pool)).toEqual({ stale: false });
  });

  it("is stale when data has been collected for over 26h and the report never succeeded", async () => {
    await metricHoursAgo(30);
    const health = await checkReportHealth(pool);
    expect(health).toMatchObject({ stale: true, hoursSinceOk: null, lastProblem: null });
  });

  it("reports the latest rejection since the last good run as the likely cause", async () => {
    await metricHoursAgo(100);
    await runHoursAgo(50, "ok");
    await runHoursAgo(60, "rejected", "no_secret_sent"); // before the ok run: ignored
    await runHoursAgo(26, "rejected", "secret_mismatch");

    const health = await checkReportHealth(pool);
    if (!health.stale) throw new Error("expected stale");
    expect(health.hoursSinceOk).toBe(50);
    expect(describeStaleCause(health, "en")).toMatch(/doesn't match/);
    expect(describeStaleCause(health, "pt")).toMatch(/não bate/);
  });
});

describe("describeStaleCause", () => {
  it("names the missing secret when the app has none configured", async () => {
    delete process.env.FLUXOMETER_CRON_SECRET;
    await metricHoursAgo(30);
    const health = await checkReportHealth(pool);
    if (!health.stale) throw new Error("expected stale");
    expect(describeStaleCause(health, "en")).toMatch(
      /Neither FLUXOMETER_CRON_SECRET nor CRON_SECRET/,
    );
    // The MCP server can't see the app's env, so it must not claim this.
    expect(describeStaleCause(health, "en", false)).not.toMatch(/Neither/);
  });

  it("points at the cron itself when the route was never called", async () => {
    await metricHoursAgo(30);
    const health = await checkReportHealth(pool);
    if (!health.stale) throw new Error("expected stale");
    expect(formatStaleAlert(health, "en")).toMatch(/never run[\s\S]*hasn't been called/);
  });
});

describe("runStaleReportWatchdog", () => {
  it("sends one Slack alert a day even when called repeatedly or from several instances", async () => {
    await metricHoursAgo(30);
    const sendSpy = vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

    expect(await runStaleReportWatchdog(pool)).toBe(true);
    expect(await runStaleReportWatchdog(pool)).toBe(false);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toMatch(/fluxometer/);
  });

  it("stays quiet when the report is healthy", async () => {
    await metricHoursAgo(100);
    await runHoursAgo(1, "ok");
    const sendSpy = vi.spyOn(slackSend, "postToSlack").mockResolvedValue();

    expect(await runStaleReportWatchdog(pool)).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("warns in the logs instead when there is no Slack webhook to alert", async () => {
    delete process.env.FLUXOMETER_SLACK_WEBHOOK_URL;
    await metricHoursAgo(30);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    expect(await runStaleReportWatchdog(pool)).toBe(false);
    expect(warnings).toContainEqual(expect.stringMatching(/hasn't succeeded/));
  });
});

describe("sanitizeErrorDetail", () => {
  it("redacts URLs (connection strings, webhooks) and caps the length", () => {
    const detail = sanitizeErrorDetail(
      new Error(
        `boom postgresql://u:secret@host:5432/db and https://hooks.slack.com/services/T/B/X ${"x".repeat(500)}`,
      ),
    );
    expect(detail).not.toContain("secret@");
    expect(detail).not.toContain("hooks.slack.com");
    expect(detail.length).toBeLessThanOrEqual(200);
  });
});
