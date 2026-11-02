import type { Pool } from "pg";
import { RULES } from "./catalog.js";
import type { RuleResult } from "./queries.js";

const SEVERITY_RANK: Record<RuleResult["severity"], number> = {
  high: 2,
  medium: 1,
};

function impact(result: RuleResult): number {
  const value =
    result.metrics.tempoTotalMs ??
    result.metrics.p95 ??
    result.metrics.reqs ??
    0;
  return typeof value === "number" ? value : Number(value) || 0;
}

function rank(results: RuleResult[]): RuleResult[] {
  return [...results].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) return severityDiff;
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
