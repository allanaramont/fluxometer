import type { Pool } from "pg";

import { getPool } from "../core/pool.js";
import { SCHEMA_NAME } from "../core/schema.js";
import { cleanupOldRows } from "../core/writer.js";
import { runEngine } from "../rules/engine.js";
import type { Locale } from "../rules/i18n/index.js";
import { verifyCronSecret } from "./auth.js";
import {
  configuredSecrets,
  notifyReportFailure,
  recordRejection,
  recordRun,
  type RejectionReason,
  sanitizeErrorDetail,
} from "./health.js";
import { formatSlackReport } from "./slackFormat.js";
import * as slackSend from "./slackSend.js";

const DUPLICATE_GUARD_MS = 5 * 60 * 1000;
let lastRunAt = 0;

/** A report that already went out in the last 6 hours is not sent again.
 * Apps can wire more than one trigger for reliability (Vercel Cron on
 * Hobby is best-effort, so a Supabase pg_cron job or a GitHub Actions
 * workflow can back it up) and the channel still gets one report a day.
 * Send `x-fluxometer-force: 1` to run anyway, e.g. to test by hand. */
export const REPORT_DEDUPE_HOURS = 6;
const REPORT_LOCK_KEY = "fluxometer.daily_report";

export function resetDuplicateGuardForTesting(): void {
  lastRunAt = 0;
}

export type FluxometerRequest = {
  header: (name: string) => string | undefined;
};
export type FluxometerResponse = { status: number; body: string };

const BEARER_PREFIX = "Bearer ";

/** GitHub Actions' template sends the secret as `x-fluxometer-secret`;
 * Vercel Cron cannot set a custom header and always sends
 * `Authorization: Bearer $CRON_SECRET` instead — both are accepted so
 * the generated Vercel template actually works. */
function providedSecret(req: FluxometerRequest): string | undefined {
  const headerValue = req.header("x-fluxometer-secret");
  if (headerValue) return headerValue;
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  return authHeader?.startsWith(BEARER_PREFIX)
    ? authHeader.slice(BEARER_PREFIX.length)
    : undefined;
}

const REJECTION_LOG: Record<RejectionReason, string> = {
  secret_not_configured:
    "fluxometer: report route is not configured — set FLUXOMETER_CRON_SECRET (or CRON_SECRET, which Vercel Cron sends) in the app's environment. Every call is rejected until then.",
  no_secret_sent:
    "fluxometer: report call rejected — it sent no secret (expected the x-fluxometer-secret header or Authorization: Bearer).",
  secret_mismatch:
    "fluxometer: report call rejected — the secret it sent doesn't match FLUXOMETER_CRON_SECRET or CRON_SECRET. The cron and the app must use the same value.",
};

function rejectionReason(req: FluxometerRequest): RejectionReason | null {
  const expected = configuredSecrets();
  if (expected.length === 0) return "secret_not_configured";
  const provided = providedSecret(req);
  if (!provided) return "no_secret_sent";
  // Both names are accepted at once: the generated GitHub Actions workflow
  // sends FLUXOMETER_CRON_SECRET, while Vercel Cron always sends its own
  // CRON_SECRET — an app may use either, or both, without them clashing.
  return expected.some((secret) => verifyCronSecret(provided, secret))
    ? null
    : "secret_mismatch";
}

export async function handleReportRequest(
  req: FluxometerRequest,
): Promise<FluxometerResponse> {
  const rejection = rejectionReason(req);
  if (rejection) {
    console.warn(REJECTION_LOG[rejection]);
    await recordRejection(rejection);
    return rejection === "secret_not_configured"
      ? { status: 503, body: "not configured" }
      : { status: 401, body: "unauthorized" };
  }

  const now = Date.now();
  if (now - lastRunAt < DUPLICATE_GUARD_MS) {
    return { status: 200, body: "ok" };
  }

  const pool = getPool();
  const force = req.header("x-fluxometer-force") === "1";
  return withReportLock(pool, async () => {
    if (!force && (await sentRecently(pool))) {
      console.log(
        `fluxometer: a report already went out in the last ${REPORT_DEDUPE_HOURS}h — not sending another (send x-fluxometer-force: 1 to override).`,
      );
      return { status: 200, body: "already sent" };
    }
    return runReport(pool, now);
  });
}

async function runReport(pool: Pool, now: number): Promise<FluxometerResponse> {
  try {
    const results = await runEngine(pool);
    const locale =
      (process.env.FLUXOMETER_LOCALE as Locale | undefined) ?? "en";
    const text = formatSlackReport(results, locale, {
      appName: process.env.FLUXOMETER_APP_NAME,
    });

    const webhookUrl = process.env.FLUXOMETER_SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      await slackSend.postToSlack(webhookUrl, text);
    } else {
      console.warn(
        "fluxometer: no Slack webhook configured (FLUXOMETER_SLACK_WEBHOOK_URL) — report computed but not sent anywhere.",
      );
    }

    await cleanupOldRows(pool);
    await recordRun(pool, "ok");

    // Only mark the run complete once it actually succeeded — a failed
    // attempt must not block an immediate retry for the next 5 minutes.
    lastRunAt = now;
    console.log(
      `fluxometer: daily report sent (${results.length} item(s)${webhookUrl ? "" : ", no Slack webhook"}).`,
    );
    return { status: 200, body: "ok" };
  } catch (err) {
    console.error("fluxometer: daily report run failed", err);
    const detail = sanitizeErrorDetail(err);
    await recordRun(pool, "failed", detail);
    await notifyReportFailure(detail);
    return { status: 500, body: "report failed" };
  }
}

async function sentRecently(pool: Pool): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `select exists (
         select 1 from ${SCHEMA_NAME}.report_runs
         where status = 'ok'
           and created_at > now() - ($1::int * interval '1 hour')
       ) as sent`,
      [REPORT_DEDUPE_HOURS],
    );
    return Boolean(rows[0]?.sent);
  } catch {
    // Older schema without report_runs: fall back to always sending.
    return false;
  }
}

/** Two triggers firing at the same second must not both send. A
 * transaction-scoped advisory lock (released at commit) is used rather
 * than a session lock, because it stays correct behind a transaction
 * pooler such as Supabase's PgBouncer, where a session lock taken on one
 * server connection could be "released" on another and leak forever. */
async function withReportLock(
  pool: Pool,
  run: () => Promise<FluxometerResponse>,
): Promise<FluxometerResponse> {
  let client;
  try {
    client = await pool.connect();
  } catch {
    // The database is unreachable: let the run fail and report why.
    return run();
  }
  let locked = false;
  try {
    await client.query("begin");
    const { rows } = await client.query(
      "select pg_try_advisory_xact_lock(hashtext($1)) as locked",
      [REPORT_LOCK_KEY],
    );
    locked = Boolean(rows[0]?.locked);
  } catch {
    // Couldn't take the lock (unusual setup): run without it rather than skip.
    await client.query("rollback").catch(() => undefined);
    client.release();
    return run();
  }
  try {
    if (!locked) return { status: 200, body: "already running" };
    return await run();
  } finally {
    await client.query("commit").catch(() => undefined);
    client.release();
  }
}
