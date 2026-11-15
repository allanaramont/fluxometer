import type { Pool } from "pg";

import { maybeRunStaleReportWatchdog } from "../report/health.js";
import { getPool, trackPending } from "./pool.js";
import { cleanLabel, cleanNames, sanitizeMessage } from "./sanitize.js";
import { SCHEMA_NAME } from "./schema.js";
import type {
  AiCallMetric,
  AuditEvent,
  ClientMetric,
  FailureEvent,
  RequestMetric,
} from "./types.js";

// Ids that travel across systems (a correlation id, a tenant key) are longer
// than a label but still bounded.
const MAX_ID_LENGTH = 128;

const warnedOnce = new Set<string>();

function logOnce(message: string, err: unknown): void {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  console.warn(`fluxometer: ${message}`, err);
}

let deployMarked = false;

export function resetDeployMarkerForTesting(): void {
  deployMarked = false;
}

/** Writes one row the first time any request is tracked after boot, so
 * the `post_deploy_regression` rule has a timestamp to anchor on. Reads
 * whichever CI-provided env var is available; no-ops (not an error) if
 * none is set, matching the spec's "sem essas env vars a regra fica
 * inativa silenciosamente". */
function markDeployOnce(): void {
  if (deployMarked) return;
  deployMarked = true;
  const deployId =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.FLUXOMETER_DEPLOY_ID;
  if (!deployId) return;
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.deploy_markers (deploy_id) values ($1)`,
      [deployId],
    )
    .catch((err) => logOnce("failed to write deploy marker", err));
  trackPending(promise);
}

export function trackRequest(input: RequestMetric): void {
  markDeployOnce();
  const watchdog = maybeRunStaleReportWatchdog();
  if (watchdog) trackPending(watchdog);
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.request_metrics
        (route, method, status, duration_ms, user_hash, platform)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.route,
        input.method,
        input.status,
        Math.round(input.durationMs),
        input.userHash ?? null,
        input.platform ?? null,
      ],
    )
    .catch((err) => logOnce("failed to write request metric", err));
  trackPending(promise);
}

export function trackClientMetric(input: ClientMetric): void {
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.client_metrics
        (screen, action, duration_ms, app_version, platform)
       values ($1, $2, $3, $4, $5)`,
      [
        input.screen,
        input.action,
        Math.round(input.durationMs),
        input.appVersion ?? null,
        input.platform ?? null,
      ],
    )
    .catch((err) => logOnce("failed to write client metric", err));
  trackPending(promise);
}

export function trackAiCall(input: AiCallMetric): void {
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.ai_calls
        (model, duration_ms, input_tokens, output_tokens, cost_usd, tools_called, success, user_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.model,
        Math.round(input.durationMs),
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.costUsd ?? null,
        input.toolsCalled ?? null,
        input.success,
        input.userHash ?? null,
      ],
    )
    .catch((err) => logOnce("failed to write AI call metric", err));
  trackPending(promise);
}

/** A failed (4xx/5xx) request, with the cause. Every free-text field is
 * sanitized and bounded here, so no caller path can store raw text. */
export function trackFailure(input: FailureEvent): void {
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.request_failures
        (route, method, status, duration_ms, error_name, error_code, message,
         correlation_id, tenant, user_hash, platform)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.route,
        input.method,
        input.status,
        input.durationMs !== undefined && Number.isFinite(input.durationMs)
          ? Math.max(0, Math.round(input.durationMs))
          : null,
        cleanLabel(input.errorName) ?? null,
        cleanLabel(input.errorCode) ?? null,
        sanitizeMessage(input.message) ?? null,
        cleanLabel(input.correlationId, MAX_ID_LENGTH) ?? null,
        cleanLabel(input.tenant, MAX_ID_LENGTH) ?? null,
        input.userHash ?? null,
        input.platform ?? null,
      ],
    )
    .catch((err) => logOnce("failed to write request failure", err));
  trackPending(promise);
}

/** "Something changed". Field NAMES only: there is no place for a value. */
export function trackAudit(input: AuditEvent): void {
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.audit_events
        (entity, action, target_id, affected_count, tenant, actor, source,
         route, method, correlation_id, fields, effect, tags)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        cleanLabel(input.entity) ?? "unknown",
        cleanLabel(input.action) ?? "unknown",
        cleanLabel(input.targetId, MAX_ID_LENGTH) ?? null,
        input.affectedCount !== undefined &&
        Number.isFinite(input.affectedCount)
          ? Math.round(input.affectedCount)
          : null,
        cleanLabel(input.tenant, MAX_ID_LENGTH) ?? null,
        cleanLabel(input.actor, MAX_ID_LENGTH) ?? null,
        cleanLabel(input.source) ?? null,
        cleanLabel(input.route, MAX_ID_LENGTH) ?? null,
        cleanLabel(input.method) ?? null,
        cleanLabel(input.correlationId, MAX_ID_LENGTH) ?? null,
        cleanNames(input.fields) ?? null,
        cleanLabel(input.effect) ?? null,
        cleanNames(input.tags) ?? null,
      ],
    )
    .catch((err) => logOnce("failed to write audit event", err));
  trackPending(promise);
}

const TABLES = [
  "request_metrics",
  "request_failures",
  "audit_events",
  "client_metrics",
  "ai_calls",
  "deploy_markers",
  "report_runs",
] as const;

export async function cleanupOldRows(
  pool: Pool,
  olderThanDays = 30,
): Promise<number> {
  let total = 0;
  for (const table of TABLES) {
    const result = await pool.query(
      `delete from ${SCHEMA_NAME}.${table}
       where created_at < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    total += result.rowCount ?? 0;
  }
  return total;
}
