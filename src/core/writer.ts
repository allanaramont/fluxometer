import type { Pool } from "pg";
import { SCHEMA_NAME } from "./schema.js";
import { getPool, trackPending } from "./pool.js";
import type { AiCallMetric, ClientMetric, RequestMetric } from "./types.js";

const warnedOnce = new Set<string>();

function logOnce(message: string, err: unknown): void {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  console.warn(`fluxometer: ${message}`, err);
}

export function trackRequest(input: RequestMetric): void {
  const promise = getPool()
    .query(
      `insert into ${SCHEMA_NAME}.request_metrics
        (route, method, status, duration_ms, user_hash, platform)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.route,
        input.method,
        input.status,
        input.durationMs,
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
        input.durationMs,
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
        input.durationMs,
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

const TABLES = ["request_metrics", "client_metrics", "ai_calls"] as const;

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
