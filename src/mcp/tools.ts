import { Pool } from "pg";

import { FluxometerError } from "../core/errors.js";
import {
  checkReportHealth,
  describeStaleCause,
  sanitizeErrorDetail,
  staleHeadline,
} from "../report/health.js";
import { runEngine } from "../rules/engine.js";
import { type Locale, resolveMessage } from "../rules/i18n/index.js";

const SUPPORTED_LOCALES: Locale[] = ["en", "es", "pt"];

let pool: Pool | undefined;

function getReadonlyPool(): Pool {
  if (!pool) {
    if (!process.env.FLUXOMETER_READONLY_URL) {
      throw new FluxometerError(
        "missing_readonly_url",
        "FLUXOMETER_READONLY_URL is not set. Run `npx fluxometer init` (or set it manually) before asking fluxometer anything.",
      );
    }
    pool = new Pool({
      connectionString: process.env.FLUXOMETER_READONLY_URL,
      max: 2,
    });
  }
  return pool;
}

export function setReadonlyPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function resetReadonlyPoolForTesting(): void {
  pool = undefined;
}

export type WhatShouldILookAtTodayResult = {
  summary: string;
  items: {
    ruleId: string;
    subject: string;
    summary: string;
    suggestion: string;
  }[];
};

export async function whatShouldILookAtToday(input: {
  locale?: Locale;
}): Promise<WhatShouldILookAtTodayResult> {
  const locale = input.locale ?? "en";
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new FluxometerError(
      "invalid_locale",
      `Unsupported locale: ${String(locale)}`,
    );
  }

  const readonlyPool = getReadonlyPool();
  const results = await runEngine(readonlyPool);
  const items: WhatShouldILookAtTodayResult["items"] = results.map((result) => {
    const { summary, suggestion } = resolveMessage(locale, result);
    return {
      ruleId: result.ruleId,
      subject: result.subject,
      summary,
      suggestion,
    };
  });
  // A daily report that stopped arriving is listed first: every other
  // answer here depends on the same data pipeline being healthy.
  try {
    const health = await checkReportHealth(readonlyPool);
    if (health.stale) {
      items.unshift({
        ruleId: "report_not_running",
        subject: "daily report",
        summary: staleHeadline(health, locale),
        suggestion: describeStaleCause(health, locale, false),
      });
    }
  } catch (err) {
    console.warn(
      "fluxometer: could not check the daily report's health (older schema, or the read-only role can't read fluxometer.report_runs)",
      sanitizeErrorDetail(err),
    );
  }

  const summary =
    items.length > 0 ? `${items.length} issue(s) found` : "No bottleneck today";
  return { summary, items };
}

const MAX_HOURS = 24 * 30;
const MAX_ROWS = 200;

function boundedInt(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.round(value)));
}

export type RecentFailuresResult = {
  windowHours: number;
  total: number;
  groups: {
    route: string;
    status: number;
    errorName: string | null;
    errorCode: string | null;
    count: number;
    lastSeen: string;
  }[];
};

/** Failed requests of the last N hours, grouped by route/status/cause. */
export async function recentFailures(input: {
  hours?: number;
  limit?: number;
}): Promise<RecentFailuresResult> {
  const hours = boundedInt(input.hours, 24, MAX_HOURS);
  const limit = boundedInt(input.limit, 20, MAX_ROWS);
  const { rows } = await getReadonlyPool().query(
    `select route, status, error_name, error_code,
            count(*)::int as count, max(created_at) as last_seen
       from fluxometer.request_failures
      where created_at > now() - ($1::int * interval '1 hour')
      group by route, status, error_name, error_code
      order by count desc, last_seen desc
      limit $2`,
    [hours, limit],
  );
  const groups = rows.map((row) => ({
    route: row.route as string,
    status: row.status as number,
    errorName: (row.error_name as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    count: row.count as number,
    lastSeen: new Date(row.last_seen as string).toISOString(),
  }));
  return {
    windowHours: hours,
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}

export type RecentAuditEventsResult = {
  windowHours: number;
  events: {
    at: string;
    entity: string;
    action: string;
    targetId: string | null;
    affectedCount: number | null;
    tenant: string | null;
    actor: string | null;
    source: string | null;
    route: string | null;
    correlationId: string | null;
    fields: string[];
    effect: string | null;
    tags: string[];
  }[];
};

/** The latest audit events, newest first, optionally filtered. */
export async function recentAuditEvents(input: {
  hours?: number;
  limit?: number;
  entity?: string;
  effect?: string;
  tenant?: string;
}): Promise<RecentAuditEventsResult> {
  const hours = boundedInt(input.hours, 24, MAX_HOURS);
  const limit = boundedInt(input.limit, 50, MAX_ROWS);
  const { rows } = await getReadonlyPool().query(
    `select created_at, entity, action, target_id, affected_count, tenant,
            actor, source, route, correlation_id, fields, effect, tags
       from fluxometer.audit_events
      where created_at > now() - ($1::int * interval '1 hour')
        and ($3::text is null or entity = $3)
        and ($4::text is null or effect = $4)
        and ($5::text is null or tenant = $5)
      order by created_at desc, id desc
      limit $2`,
    [
      hours,
      limit,
      input.entity ?? null,
      input.effect ?? null,
      input.tenant ?? null,
    ],
  );
  return {
    windowHours: hours,
    events: rows.map((row) => ({
      at: new Date(row.created_at as string).toISOString(),
      entity: row.entity as string,
      action: row.action as string,
      targetId: (row.target_id as string | null) ?? null,
      affectedCount: (row.affected_count as number | null) ?? null,
      tenant: (row.tenant as string | null) ?? null,
      actor: (row.actor as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      route: (row.route as string | null) ?? null,
      correlationId: (row.correlation_id as string | null) ?? null,
      fields: (row.fields as string[] | null) ?? [],
      effect: (row.effect as string | null) ?? null,
      tags: (row.tags as string[] | null) ?? [],
    })),
  };
}
