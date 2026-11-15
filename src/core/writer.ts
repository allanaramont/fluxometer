import type { Pool } from "pg";

import { maybeRunStaleReportWatchdog } from "../report/health.js";
import { getPool, trackPending } from "./pool.js";
import {
  clampInt4,
  cleanLabel,
  cleanNames,
  sanitizeMessage,
} from "./sanitize.js";
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

// A scanner or a client in a retry loop can hit a matched route with bad input
// thousands of times a second; one INSERT per failure would queue behind the
// 2-connection pool and grow the host's memory. Failure rows are rate-limited
// per process, in two layers:
//  - PER KEY (route, status, error name/code): one noisy kind of failure cannot
//    use up the budget and hide every other kind;
//  - GLOBAL, as a backstop for pool and memory when the keys themselves are
//    many.
// Rows over a cap are dropped and counted, and the counts (total and the
// noisiest keys) are logged once per window - the volume stays visible even
// though the rows do not.
const DEFAULT_PER_KEY_PER_MINUTE = 20;
const DEFAULT_FAILURES_PER_MINUTE = 600;
const MAX_TRACKED_KEYS = 500;
const OVERFLOW_KEY = "<other>";

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

let failureWindowStart = 0;
let failuresInWindow = 0;
const failureKeyCounts = new Map<string, { admitted: number; dropped: number }>();

export function resetFailureLimiterForTesting(): void {
  failureWindowStart = 0;
  failuresInWindow = 0;
  failureKeyCounts.clear();
}

function failureKey(input: FailureEvent): string {
  return [
    input.route,
    input.status,
    String(input.errorName ?? "").slice(0, 64),
    String(input.errorCode ?? "").slice(0, 64),
  ].join("|");
}

function reportDropped(): void {
  const dropped = [...failureKeyCounts.entries()]
    .filter(([, c]) => c.dropped > 0)
    .sort((a, b) => b[1].dropped - a[1].dropped);
  if (dropped.length === 0) return;
  const total = dropped.reduce((sum, [, c]) => sum + c.dropped, 0);
  const top = dropped
    .slice(0, 3)
    .map(([key, c]) => `${key} x${c.dropped}`)
    .join("; ");
  console.warn(
    `fluxometer: dropped ${total} failure row(s) in the last minute (caps: ${envInt("FLUXOMETER_FAILURES_PER_KEY_PER_MINUTE", DEFAULT_PER_KEY_PER_MINUTE)}/key, ${envInt("FLUXOMETER_FAILURES_PER_MINUTE", DEFAULT_FAILURES_PER_MINUTE)} total). Noisiest: ${top}`,
  );
}

/** True if this failure may be written now; counts the ones that may not. */
function admitFailure(input: FailureEvent, now: number = Date.now()): boolean {
  if (now - failureWindowStart >= 60_000) {
    reportDropped();
    failureWindowStart = now;
    failuresInWindow = 0;
    failureKeyCounts.clear();
  }
  let key = failureKey(input);
  if (!failureKeyCounts.has(key) && failureKeyCounts.size >= MAX_TRACKED_KEYS) {
    key = OVERFLOW_KEY; // bounded memory: unknown keys share one bucket
  }
  const entry = failureKeyCounts.get(key) ?? { admitted: 0, dropped: 0 };
  failureKeyCounts.set(key, entry);
  // The overflow bucket stands for MANY unrelated kinds of failure: holding it
  // to the per-key cap would let the first few hide every new kind once the
  // tracker is full. It is limited by the global backstop only.
  const overPerKey =
    key !== OVERFLOW_KEY &&
    entry.admitted >=
      envInt(
        "FLUXOMETER_FAILURES_PER_KEY_PER_MINUTE",
        DEFAULT_PER_KEY_PER_MINUTE,
      );
  if (
    overPerKey ||
    failuresInWindow >=
      envInt("FLUXOMETER_FAILURES_PER_MINUTE", DEFAULT_FAILURES_PER_MINUTE)
  ) {
    entry.dropped += 1;
    return false;
  }
  entry.admitted += 1;
  failuresInWindow += 1;
  return true;
}

/** A failed (4xx/5xx) request, with the cause. Every free-text field is
 * sanitized and bounded here, so no caller path can store raw text. */
export function trackFailure(input: FailureEvent): void {
  if (!admitFailure(input)) return;
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
        clampInt4(input.affectedCount),
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
