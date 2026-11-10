import type { Pool } from "pg";

import { getPool } from "../core/pool.js";
import { SCHEMA_NAME } from "../core/schema.js";
import type { Locale } from "../rules/i18n/index.js";
import * as slackSend from "./slackSend.js";

/** How long without a successful report before fluxometer calls it
 * "not running". The report is daily, so 26h leaves room for a cron that
 * fires a bit late without crying wolf. */
export const STALE_AFTER_HOURS = 26;

/** One stale-report alert per day at most, across every instance of the
 * app (deduplicated through the `report_runs` table, not process memory,
 * since serverless instances come and go). */
const STALE_ALERT_COOLDOWN_HOURS = 24;

/** The watchdog runs from the request path, so it checks at most once an
 * hour per process — one cheap indexed query, never per request. */
const WATCHDOG_INTERVAL_MS = 60 * 60 * 1000;

/** Rejected calls are recorded so the stale alert can say *why* the cron
 * isn't getting through. The route is public, so this is throttled per
 * process to keep anyone hammering it from filling the table. */
const REJECTION_RECORD_INTERVAL_MS = 10 * 60 * 1000;

export type RejectionReason =
  | "secret_not_configured"
  | "no_secret_sent"
  | "secret_mismatch";

type RunStatus = "ok" | "failed" | "rejected" | "stale_alert";

/** Error messages end up in Slack and in the database, so anything that
 * looks like a URL (a connection string, a webhook) is redacted and the
 * text is kept short. */
export function sanitizeErrorDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<redacted-url>")
    .slice(0, 200);
}

export function configuredSecrets(): string[] {
  return [process.env.FLUXOMETER_CRON_SECRET, process.env.CRON_SECRET].filter(
    (value): value is string => Boolean(value),
  );
}

async function insertRun(
  pool: Pool,
  status: RunStatus,
  detail: string | null,
): Promise<void> {
  await pool.query(
    `insert into ${SCHEMA_NAME}.report_runs (status, detail) values ($1, $2)`,
    [status, detail],
  );
}

/** Best-effort: recording a run must never change the route's answer. */
export async function recordRun(
  pool: Pool,
  status: "ok" | "failed",
  detail: string | null = null,
): Promise<void> {
  try {
    await insertRun(pool, status, detail);
  } catch (err) {
    console.warn(
      "fluxometer: could not record the report run (did `npm run fluxometer:migrate` / runMigration run after upgrading?)",
      sanitizeErrorDetail(err),
    );
  }
}

let lastRejectionRecordedAt = 0;

export async function recordRejection(reason: RejectionReason): Promise<void> {
  const now = Date.now();
  if (now - lastRejectionRecordedAt < REJECTION_RECORD_INTERVAL_MS) return;
  lastRejectionRecordedAt = now;
  try {
    await insertRun(getPool(), "rejected", reason);
  } catch {
    // The rejection itself is already logged by the route.
  }
}

export type ReportHealth =
  | { stale: false }
  | {
      stale: true;
      /** Hours since the last successful report, or null if there never was one. */
      hoursSinceOk: number | null;
      lastProblem: { status: "failed" | "rejected"; detail: string; at: Date } | null;
    };

/** "Stale" means: no successful report in the last 26h, and fluxometer has
 * been collecting data for longer than that (a fresh install that simply
 * hasn't reached its first cron run yet is not a problem). */
export async function checkReportHealth(pool: Pool): Promise<ReportHealth> {
  const { rows } = await pool.query(
    `select
       (select max(created_at) from ${SCHEMA_NAME}.report_runs where status = 'ok') as last_ok,
       (select min(created_at) from ${SCHEMA_NAME}.request_metrics) as first_metric,
       now() - ($1::int * interval '1 hour') as threshold`,
    [STALE_AFTER_HOURS],
  );
  const lastOk: Date | null = rows[0].last_ok;
  const firstMetric: Date | null = rows[0].first_metric;
  const threshold: Date = rows[0].threshold;

  if (lastOk && lastOk > threshold) return { stale: false };
  if (!lastOk && (!firstMetric || firstMetric > threshold)) {
    return { stale: false };
  }

  const problem = await pool.query(
    `select status, detail, created_at from ${SCHEMA_NAME}.report_runs
     where status in ('failed', 'rejected')
       and created_at > coalesce($1::timestamptz, '-infinity'::timestamptz)
     order by created_at desc limit 1`,
    [lastOk],
  );
  const row = problem.rows[0];
  return {
    stale: true,
    hoursSinceOk: lastOk
      ? Math.floor((Date.now() - lastOk.getTime()) / 3_600_000)
      : null,
    lastProblem: row
      ? { status: row.status, detail: row.detail ?? "", at: row.created_at }
      : null,
  };
}

const TEXT = {
  en: {
    failedHeader: "fluxometer: today's report failed",
    failedBody: (detail: string) =>
      `Error: ${detail}\nThe next cron run will try again. Check that DATABASE_URL points to the app's Postgres and that the migration ran after the last upgrade.`,
    staleHeader: (hours: number | null) =>
      hours === null
        ? "fluxometer: the daily report has never run"
        : `fluxometer: no daily report in the last ${hours}h`,
    secretNotConfigured:
      "Neither FLUXOMETER_CRON_SECRET nor CRON_SECRET is set in the app, so the report route rejects every call.",
    rejected: (at: string, why: string) =>
      `The last call to the report route (${at}) was rejected: ${why}.`,
    noSecretSent:
      "it sent no secret (expected `x-fluxometer-secret` or `Authorization: Bearer`)",
    secretMismatch:
      "the secret it sent doesn't match FLUXOMETER_CRON_SECRET or CRON_SECRET in the app — the cron and the app must use the same value",
    secretNotConfiguredShort: "no cron secret is configured in the app",
    failed: (at: string, detail: string) =>
      `The last run (${at}) failed: ${detail}`,
    neverCalled:
      "The report route hasn't been called at all. Check that the cron (GitHub Actions workflow or Vercel Cron) exists and points to the right URL, and that the route answers GET (Vercel Cron) as well as POST.",
  },
  pt: {
    failedHeader: "fluxometer: o relatório de hoje falhou",
    failedBody: (detail: string) =>
      `Erro: ${detail}\nA próxima execução do cron tenta de novo. Confira se o DATABASE_URL aponta para o Postgres do app e se a migration rodou depois do último upgrade.`,
    staleHeader: (hours: number | null) =>
      hours === null
        ? "fluxometer: o relatório diário nunca rodou"
        : `fluxometer: nenhum relatório diário nas últimas ${hours}h`,
    secretNotConfigured:
      "Nem FLUXOMETER_CRON_SECRET nem CRON_SECRET estão definidos no app, então a rota do relatório rejeita toda chamada.",
    rejected: (at: string, why: string) =>
      `A última chamada à rota do relatório (${at}) foi rejeitada: ${why}.`,
    noSecretSent:
      "ela não enviou secret (esperado `x-fluxometer-secret` ou `Authorization: Bearer`)",
    secretMismatch:
      "o secret enviado não bate com FLUXOMETER_CRON_SECRET nem com CRON_SECRET do app — o cron e o app precisam usar o mesmo valor",
    secretNotConfiguredShort: "nenhum secret de cron está configurado no app",
    failed: (at: string, detail: string) =>
      `A última execução (${at}) falhou: ${detail}`,
    neverCalled:
      "A rota do relatório não foi chamada nenhuma vez. Confira se o cron (workflow do GitHub Actions ou Vercel Cron) existe e aponta para a URL certa, e se a rota aceita GET (Vercel Cron) além de POST.",
  },
  es: {
    failedHeader: "fluxometer: el reporte de hoy falló",
    failedBody: (detail: string) =>
      `Error: ${detail}\nLa próxima ejecución del cron lo intentará de nuevo. Revisa que DATABASE_URL apunte al Postgres de la app y que la migración haya corrido después de la última actualización.`,
    staleHeader: (hours: number | null) =>
      hours === null
        ? "fluxometer: el reporte diario nunca se ejecutó"
        : `fluxometer: ningún reporte diario en las últimas ${hours}h`,
    secretNotConfigured:
      "Ni FLUXOMETER_CRON_SECRET ni CRON_SECRET están definidos en la app, así que la ruta del reporte rechaza todas las llamadas.",
    rejected: (at: string, why: string) =>
      `La última llamada a la ruta del reporte (${at}) fue rechazada: ${why}.`,
    noSecretSent:
      "no envió ningún secret (se espera `x-fluxometer-secret` o `Authorization: Bearer`)",
    secretMismatch:
      "el secret enviado no coincide con FLUXOMETER_CRON_SECRET ni con CRON_SECRET de la app — el cron y la app deben usar el mismo valor",
    secretNotConfiguredShort: "no hay ningún secret de cron configurado en la app",
    failed: (at: string, detail: string) =>
      `La última ejecución (${at}) falló: ${detail}`,
    neverCalled:
      "La ruta del reporte no se ha llamado ninguna vez. Revisa que el cron (workflow de GitHub Actions o Vercel Cron) exista y apunte a la URL correcta, y que la ruta acepte GET (Vercel Cron) además de POST.",
  },
} satisfies Record<Locale, unknown>;

function textFor(locale: Locale) {
  return TEXT[locale] ?? TEXT.en;
}

export function currentLocale(): Locale {
  const value = process.env.FLUXOMETER_LOCALE;
  return value === "pt" || value === "es" ? value : "en";
}

export function formatFailureAlert(detail: string, locale: Locale): string {
  const t = textFor(locale);
  return `⚠️ *${t.failedHeader}*\n${t.failedBody(detail)}`;
}

/** The diagnosis line explaining why the report isn't running, used by
 * both the Slack alert and the MCP tool. `inAppProcess` is false for the
 * MCP server, which runs on a developer's machine and can't see the app's
 * environment variables — only what the app recorded in the database. */
export function describeStaleCause(
  health: Extract<ReportHealth, { stale: true }>,
  locale: Locale,
  inAppProcess = true,
): string {
  const t = textFor(locale);
  if (inAppProcess && configuredSecrets().length === 0) {
    return t.secretNotConfigured;
  }
  const problem = health.lastProblem;
  if (!problem) return t.neverCalled;
  const at = problem.at.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  if (problem.status === "failed") return t.failed(at, problem.detail);
  const why =
    problem.detail === "no_secret_sent"
      ? t.noSecretSent
      : problem.detail === "secret_not_configured"
        ? t.secretNotConfiguredShort
        : t.secretMismatch;
  return t.rejected(at, why);
}

export function staleHeadline(
  health: Extract<ReportHealth, { stale: true }>,
  locale: Locale,
): string {
  return textFor(locale).staleHeader(health.hoursSinceOk);
}

export function formatStaleAlert(
  health: Extract<ReportHealth, { stale: true }>,
  locale: Locale,
): string {
  const t = textFor(locale);
  return `⚠️ *${t.staleHeader(health.hoursSinceOk)}*\n${describeStaleCause(health, locale)}`;
}

/** Sends a failure alert for a report run that just failed. Never throws:
 * if Slack itself is what's failing, there is nothing more to do here. */
export async function notifyReportFailure(detail: string): Promise<void> {
  const webhookUrl = process.env.FLUXOMETER_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await slackSend.postToSlack(
      webhookUrl,
      formatFailureAlert(detail, currentLocale()),
    );
  } catch {
    // Already logged by the route; a second Slack error adds nothing.
  }
}

let lastWatchdogAt = 0;
let watchdogWarnedNoWebhook = false;

export function resetHealthStateForTesting(): void {
  lastWatchdogAt = 0;
  lastRejectionRecordedAt = 0;
  watchdogWarnedNoWebhook = false;
}

/** Checks whether the daily report stopped arriving and, if so, posts one
 * Slack alert (at most one a day across all instances) saying why. Runs
 * from the app's own request path because a report that never runs can't
 * report on itself — the cron may be missing, pointing at the wrong URL,
 * or sending the wrong secret. */
export async function runStaleReportWatchdog(pool: Pool): Promise<boolean> {
  const health = await checkReportHealth(pool);
  if (!health.stale) return false;

  const webhookUrl = process.env.FLUXOMETER_SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    if (!watchdogWarnedNoWebhook) {
      watchdogWarnedNoWebhook = true;
      console.warn(
        `fluxometer: the daily report hasn't succeeded in over ${STALE_AFTER_HOURS}h — ${describeStaleCause(health, "en")} (no FLUXOMETER_SLACK_WEBHOOK_URL set, so this warning is the only alert)`,
      );
    }
    return false;
  }

  // Claim today's alert first, so two instances racing here send one alert.
  const claimed = await pool.query(
    `insert into ${SCHEMA_NAME}.report_runs (status, detail)
     select 'stale_alert', null
     where not exists (
       select 1 from ${SCHEMA_NAME}.report_runs
       where status = 'stale_alert'
         and created_at > now() - ($1::int * interval '1 hour')
     )`,
    [STALE_ALERT_COOLDOWN_HOURS],
  );
  if ((claimed.rowCount ?? 0) === 0) return false;

  await slackSend.postToSlack(
    webhookUrl,
    formatStaleAlert(health, currentLocale()),
  );
  return true;
}

/** Fire-and-forget entry point for the request path: at most once an hour
 * per process, never throws, never delays the request. Opt out with
 * `FLUXOMETER_WATCHDOG=off`. */
export function maybeRunStaleReportWatchdog(): Promise<void> | undefined {
  if (process.env.FLUXOMETER_WATCHDOG === "off") return undefined;
  const now = Date.now();
  if (now - lastWatchdogAt < WATCHDOG_INTERVAL_MS) return undefined;
  lastWatchdogAt = now;
  return runStaleReportWatchdog(getPool()).then(
    () => undefined,
    (err) => {
      console.warn(
        "fluxometer: stale-report check failed",
        sanitizeErrorDetail(err),
      );
    },
  );
}
