import { getPool } from "../core/pool.js";
import { cleanupOldRows } from "../core/writer.js";
import { runEngine } from "../rules/engine.js";
import type { Locale } from "../rules/i18n/index.js";
import { verifyCronSecret } from "./auth.js";
import { formatSlackReport } from "./slackFormat.js";
import * as slackSend from "./slackSend.js";

const DUPLICATE_GUARD_MS = 5 * 60 * 1000;
let lastRunAt = 0;

export type FluxometerRequest = {
  header: (name: string) => string | undefined;
};
export type FluxometerResponse = { status: number; body: string };

export async function handleReportRequest(
  req: FluxometerRequest,
): Promise<FluxometerResponse> {
  const expected = process.env.FLUXOMETER_CRON_SECRET;
  if (
    !expected ||
    !verifyCronSecret(req.header("x-fluxometer-secret"), expected)
  ) {
    return { status: 401, body: "unauthorized" };
  }

  const now = Date.now();
  if (now - lastRunAt < DUPLICATE_GUARD_MS) {
    return { status: 200, body: "ok" };
  }
  lastRunAt = now;

  const pool = getPool();
  const results = await runEngine(pool);
  const locale = (process.env.FLUXOMETER_LOCALE as Locale | undefined) ?? "en";
  const text = formatSlackReport(results, locale);

  const webhookUrl = process.env.FLUXOMETER_SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    await slackSend.postToSlack(webhookUrl, text);
  }

  await cleanupOldRows(pool);

  return { status: 200, body: "ok" };
}
