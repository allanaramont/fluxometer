import type { Pool } from "pg";

import { RULES } from "./catalog.js";
import type { RuleId, RuleResult } from "./queries.js";

const SEVERITY_RANK: Record<RuleResult["severity"], number> = {
  high: 2,
  medium: 1,
};

/** A live incident (an error spike happening right now) always matters
 * more than a chronically slow endpoint, no matter how large that
 * endpoint's own raw metrics are — comparing `totalMs` against
 * `reqs` directly (incomparable units) would let a big-but-harmless
 * number outrank a small-but-urgent one. This fixed order is the primary
 * sort key within a severity tier; each rule's own metric magnitude only
 * breaks ties between two firings of the *same* rule. */
const RULE_PRIORITY: Record<RuleId, number> = {
  error_spike: 12,
  timeout_spike: 11,
  ai_failure_rate: 10,
  post_deploy_regression: 9,
  regression: 8,
  slow_route: 7,
  ai_cost_spike: 6,
  platform_error_concentration: 5,
  high_variance: 4,
  slow_query: 3,
  peak_hour_bottleneck: 2,
  top_consumer: 1,
};

function impact(result: RuleResult): number {
  const value =
    result.metrics.totalMs ??
    result.metrics.p95 ??
    result.metrics.reqs ??
    0;
  return typeof value === "number" ? value : Number(value) || 0;
}

export function rank(results: RuleResult[]): RuleResult[] {
  return [...results].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) return severityDiff;
    const priorityDiff = RULE_PRIORITY[b.ruleId] - RULE_PRIORITY[a.ruleId];
    if (priorityDiff !== 0) return priorityDiff;
    return impact(b) - impact(a);
  });
}

export async function runEngine(pool: Pool): Promise<RuleResult[]> {
  const settled = await Promise.allSettled(RULES.map((rule) => rule(pool)));
  const results: RuleResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.push(...outcome.value);
    } else {
      console.warn("fluxometer: a rule failed and was skipped", outcome.reason);
    }
  }
  return rank(results);
}
