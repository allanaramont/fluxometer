import { getPool } from "../core/pool.js";
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
  try {
    const results = await runEngine(pool);
    const locale =
      (process.env.FLUXOMETER_LOCALE as Locale | undefined) ?? "en";
    const text = formatSlackReport(results, locale);

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
    return { status: 200, body: "ok" };
  } catch (err) {
    console.error("fluxometer: daily report run failed", err);
    const detail = sanitizeErrorDetail(err);
    await recordRun(pool, "failed", detail);
    await notifyReportFailure(detail);
    return { status: 500, body: "report failed" };
  }
}
