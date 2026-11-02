import type { Pool } from "pg";
import { SCHEMA_NAME } from "../core/schema.js";

export type RuleId =
  | "slow_route"
  | "regression"
  | "top_consumer"
  | "error_spike"
  | "slow_query"
  | "high_variance"
  | "platform_error_concentration"
  | "timeout_spike"
  | "ai_cost_spike"
  | "ai_failure_rate"
  | "peak_hour_bottleneck"
  | "post_deploy_regression";

export type RuleResult = {
  ruleId: RuleId;
  severity: "high" | "medium";
  subject: string;
  metrics: Record<string, number | string>;
};

const num = (value: unknown): number =>
  typeof value === "number" ? value : Number(value) || 0;

export async function slowRoute(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select route,
        percentile_cont(0.95) within group (order by duration_ms) as p95,
        count(*) as reqs,
        sum(duration_ms) as total_ms
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '24 hours'
     group by route
     having count(*) >= 50 and percentile_cont(0.95) within group (order by duration_ms) > 800`,
  );
  return rows.map((row) => ({
    ruleId: "slow_route" as const,
    severity: "high" as const,
    subject: row.route,
    metrics: {
      p95: num(row.p95),
      reqs: num(row.reqs),
      tempoTotalMs: num(row.total_ms),
    },
  }));
}

export async function regression(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `with atual as (
        select route, percentile_cont(0.95) within group (order by duration_ms) as p95, count(*) as reqs
        from ${SCHEMA_NAME}.request_metrics
        where created_at > now() - interval '24 hours'
        group by route having count(*) >= 20
     ),
     anterior as (
        select route, percentile_cont(0.95) within group (order by duration_ms) as p95
        from ${SCHEMA_NAME}.request_metrics
        where created_at between now() - interval '8 days' and now() - interval '7 days'
        group by route
     )
     select a.route, a.p95 as p95_now, b.p95 as p95_before, a.reqs
     from atual a join anterior b using (route)
     where b.p95 > 0 and (a.p95 - b.p95) / b.p95 > 0.3`,
  );
  return rows.map((row) => ({
    ruleId: "regression" as const,
    severity: "high" as const,
    subject: row.route,
    metrics: {
      p95: num(row.p95_now),
      p95Before: num(row.p95_before),
      variacaoPct: Math.round(
        ((num(row.p95_now) - num(row.p95_before)) / num(row.p95_before)) * 100,
      ),
    },
  }));
}

export async function topConsumer(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select route, sum(duration_ms) as total_ms, count(*) as reqs
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '24 hours'
     group by route
     order by total_ms desc
     limit 3`,
  );
  return rows.map((row) => ({
    ruleId: "top_consumer" as const,
    severity: "medium" as const,
    subject: row.route,
    metrics: { tempoTotalMs: num(row.total_ms), reqs: num(row.reqs) },
  }));
}

const ERROR_RATE_THRESHOLD = 0.02;
const MIN_BUCKET_VOLUME = 10;

/** The only trigger is one daily cron run (spec: "um único cron diário"),
 * so a plain "last 1 hour" window would miss 23 of every 24 hours — an
 * outage at 3am would never show up in an 8am report. Instead, every
 * hourly bucket in the last 24h is checked and each route's worst bucket
 * is what gets evaluated against the threshold. */
export async function errorSpike(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select route, avg((status >= 500)::int) as rate, count(*) as reqs
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '24 hours'
     group by route, date_trunc('hour', created_at)
     having count(*) >= ${MIN_BUCKET_VOLUME}`,
  );
  return worstBucketPerRoute(rows)
    .filter((bucket) => bucket.rate > ERROR_RATE_THRESHOLD)
    .map((bucket) => ({
      ruleId: "error_spike" as const,
      severity: "high" as const,
      subject: bucket.route,
      metrics: { taxaErro: bucket.rate, reqs: bucket.reqs },
    }));
}

type Bucket = { route: string; rate: number; reqs: number };

function worstBucketPerRoute(
  rows: { route: string; rate: unknown; reqs: unknown }[],
): Bucket[] {
  const worstByRoute = new Map<string, Bucket>();
  for (const row of rows) {
    const bucket: Bucket = {
      route: row.route,
      rate: num(row.rate),
      reqs: num(row.reqs),
    };
    const current = worstByRoute.get(row.route);
    if (!current || bucket.rate > current.rate) {
      worstByRoute.set(row.route, bucket);
    }
  }
  return [...worstByRoute.values()];
}

/** `pg_stat_statements` is cluster-wide and can contain DDL the app ran
 * itself — including this very package's own `create/alter role ...
 * password '<literal>'` during `init`/`rotate`. Scoped to the current
 * database and filtered to never surface anything that looks like it
 * carries a password, so that text never reaches the Slack report. */
export async function slowQuery(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select query, mean_exec_time, calls
     from pg_stat_statements
     where dbid = (select oid from pg_database where datname = current_database())
       and mean_exec_time > 200
       and query not ilike '%password%'
     order by mean_exec_time desc
     limit 5`,
  );
  return rows.map((row) => ({
    ruleId: "slow_query" as const,
    severity: "medium" as const,
    subject: String(row.query).slice(0, 80),
    metrics: { meanExecMs: num(row.mean_exec_time), calls: num(row.calls) },
  }));
}

const HIGH_VARIANCE_MULTIPLIER = 3;

export async function highVariance(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select route,
        percentile_cont(0.99) within group (order by duration_ms) as p99,
        percentile_cont(0.5) within group (order by duration_ms) as p50,
        count(*) as reqs
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '24 hours'
     group by route
     having count(*) >= 50`,
  );
  return rows
    .filter(
      (row) =>
        num(row.p50) > 0 &&
        num(row.p99) / num(row.p50) > HIGH_VARIANCE_MULTIPLIER,
    )
    .map((row) => ({
      ruleId: "high_variance" as const,
      severity: "medium" as const,
      subject: row.route,
      metrics: { p99: num(row.p99), p50: num(row.p50), reqs: num(row.reqs) },
    }));
}

const PLATFORM_ERROR_MULTIPLIER = 2;

/** With only two platforms (the common web-vs-ios case), a plain
 * `rate > mean + stdev` filter can never fire: for rates [a, b],
 * mean + stdev always equals max(a, b) exactly, excluding it from a
 * strict `>` test. Instead, each platform's rate is compared against the
 * pooled rate of every *other* platform, with an absolute floor so a
 * platform with zero other-platform errors to compare against isn't
 * flagged for noise. */
export async function platformErrorConcentration(
  pool: Pool,
): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select platform, sum((status >= 500)::int) as errors, count(*) as reqs
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '24 hours' and platform is not null
     group by platform
     having count(*) >= 20`,
  );
  if (rows.length < 2) return [];

  const platforms = rows.map((row) => ({
    platform: row.platform,
    errors: num(row.errors),
    reqs: num(row.reqs),
  }));
  const totalErrors = platforms.reduce((a, p) => a + p.errors, 0);
  const totalReqs = platforms.reduce((a, p) => a + p.reqs, 0);

  const results: RuleResult[] = [];
  for (const p of platforms) {
    const restErrors = totalErrors - p.errors;
    const restReqs = totalReqs - p.reqs;
    const restRate = restReqs > 0 ? restErrors / restReqs : 0;
    const rate = p.reqs > 0 ? p.errors / p.reqs : 0;
    const isWorseThanTheRest = rate > restRate * PLATFORM_ERROR_MULTIPLIER;
    const isMeaningfullyBad = rate > ERROR_RATE_THRESHOLD;
    if (isWorseThanTheRest && isMeaningfullyBad) {
      results.push({
        ruleId: "platform_error_concentration" as const,
        severity: "medium" as const,
        subject: p.platform,
        metrics: {
          taxaErro: rate,
          mediaOutrasPlataformas: restRate,
          reqs: p.reqs,
        },
      });
    }
  }
  return results;
}

const TIMEOUT_STATUSES = [504, 408];
const TIMEOUT_RATE_THRESHOLD = 0.01;

/** Same 24h-worst-bucket reasoning as errorSpike — a daily cron can't
 * rely on a "last 1 hour" window to catch a timeout spike that happened
 * at any other hour of the day. */
export async function timeoutSpike(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select route, avg((status = any($1))::int) as rate, count(*) as reqs
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '24 hours'
     group by route, date_trunc('hour', created_at)
     having count(*) >= ${MIN_BUCKET_VOLUME}`,
    [TIMEOUT_STATUSES],
  );
  return worstBucketPerRoute(rows)
    .filter((bucket) => bucket.rate > TIMEOUT_RATE_THRESHOLD)
    .map((bucket) => ({
      ruleId: "timeout_spike" as const,
      severity: "high" as const,
      subject: bucket.route,
      metrics: { taxaTimeout: bucket.rate, reqs: bucket.reqs },
    }));
}

export async function aiCostSpike(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `with hoje as (
        select avg(cost_usd) as avg_cost, count(*) as calls
        from ${SCHEMA_NAME}.ai_calls
        where created_at > now() - interval '24 hours'
     ),
     antes as (
        select avg(cost_usd) as avg_cost, count(*) as calls
        from ${SCHEMA_NAME}.ai_calls
        where created_at between now() - interval '8 days' and now() - interval '7 days'
     )
     select h.avg_cost as avg_cost_now, a.avg_cost as avg_cost_before, h.calls as calls_now, a.calls as calls_before
     from hoje h, antes a`,
  );
  const row = rows[0];
  if (!row || !row.avg_cost_before || num(row.avg_cost_before) === 0) return [];
  const costUp = num(row.avg_cost_now) > num(row.avg_cost_before) * 1.3;
  const volumeStable = num(row.calls_now) <= num(row.calls_before) * 1.1;
  if (!costUp || !volumeStable) return [];
  return [
    {
      ruleId: "ai_cost_spike" as const,
      severity: "medium" as const,
      subject: "ai_calls",
      metrics: {
        custoMedioHoje: num(row.avg_cost_now),
        custoMedioAntes: num(row.avg_cost_before),
        chamadasHoje: num(row.calls_now),
      },
    },
  ];
}

export async function aiFailureRate(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select model, avg((success = false)::int) as failure_rate, count(*) as calls
     from ${SCHEMA_NAME}.ai_calls
     where created_at > now() - interval '24 hours'
     group by model
     having count(*) >= 20 and avg((success = false)::int) > 0.05`,
  );
  return rows.map((row) => ({
    ruleId: "ai_failure_rate" as const,
    severity: "high" as const,
    subject: row.model,
    metrics: { taxaFalha: num(row.failure_rate), chamadas: num(row.calls) },
  }));
}

const PEAK_HOUR_MULTIPLIER = 2;

export async function peakHourBottleneck(pool: Pool): Promise<RuleResult[]> {
  const { rows } = await pool.query(
    `select route, extract(hour from created_at)::int as hour_of_day,
        percentile_cont(0.95) within group (order by duration_ms) as p95,
        count(*) as reqs
     from ${SCHEMA_NAME}.request_metrics
     where created_at > now() - interval '7 days'
     group by route, hour_of_day
     having count(*) >= 20`,
  );

  const byRoute = new Map<
    string,
    { hour: number; p95: number; reqs: number }[]
  >();
  for (const row of rows) {
    const list = byRoute.get(row.route) ?? [];
    list.push({
      hour: row.hour_of_day,
      p95: num(row.p95),
      reqs: num(row.reqs),
    });
    byRoute.set(row.route, list);
  }

  const results: RuleResult[] = [];
  for (const [route, buckets] of byRoute) {
    if (buckets.length < 2) continue;
    const avgP95 = buckets.reduce((a, b) => a + b.p95, 0) / buckets.length;
    if (avgP95 === 0) continue;
    for (const bucket of buckets) {
      if (bucket.p95 > avgP95 * PEAK_HOUR_MULTIPLIER) {
        results.push({
          ruleId: "peak_hour_bottleneck",
          severity: "medium",
          subject: route,
          metrics: {
            horaDoDia: bucket.hour,
            p95: bucket.p95,
            p95Medio: avgP95,
            reqs: bucket.reqs,
          },
        });
      }
    }
  }
  return results;
}

export async function postDeployRegression(pool: Pool): Promise<RuleResult[]> {
  const { rows: markerRows } = await pool.query(
    `select created_at from ${SCHEMA_NAME}.deploy_markers order by created_at desc limit 1`,
  );
  const marker = markerRows[0];
  if (!marker) return [];

  const { rows } = await pool.query(
    `with depois as (
        select route, percentile_cont(0.95) within group (order by duration_ms) as p95, count(*) as reqs
        from ${SCHEMA_NAME}.request_metrics
        where created_at between $1::timestamptz and $1::timestamptz + interval '2 hours'
        group by route having count(*) >= 20
     ),
     antes as (
        select route, percentile_cont(0.95) within group (order by duration_ms) as p95
        from ${SCHEMA_NAME}.request_metrics
        where created_at between $1::timestamptz - interval '2 hours' and $1::timestamptz
        group by route
     )
     select d.route, d.p95 as p95_after, a.p95 as p95_before, d.reqs
     from depois d join antes a using (route)
     where a.p95 > 0 and (d.p95 - a.p95) / a.p95 > 0.3`,
    [marker.created_at],
  );
  return rows.map((row) => ({
    ruleId: "post_deploy_regression" as const,
    severity: "high" as const,
    subject: row.route,
    metrics: {
      p95Depois: num(row.p95_after),
      p95Antes: num(row.p95_before),
      reqs: num(row.reqs),
    },
  }));
}
