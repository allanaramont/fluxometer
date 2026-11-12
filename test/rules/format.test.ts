import { describe, expect, it } from "vitest";

import { resolveMessage } from "../../src/rules/i18n/index.js";
import type { RuleResult } from "../../src/rules/queries.js";

describe("report message formatting", () => {
  it("rounds durations and adds thousands separators (the report showed 522.4849999999999ms)", () => {
    const result: RuleResult = {
      ruleId: "peak_hour_bottleneck",
      severity: "medium",
      subject: "/mcp/",
      metrics: { hourOfDay: 17, timeZone: "America/Sao_Paulo", p95: 1160.2, avgP95: 522.4849999999999, reqs: 40 },
    };
    const { summary } = resolveMessage("pt", result);
    expect(summary).toBe(
      "`/mcp/` fica lenta por volta das 17:00 (p95 1.160 ms vs 522 ms na média, últimos 7 dias)",
    );
    expect(resolveMessage("en", result).summary).toContain("around 17:00 (p95 1,160 ms vs 522 ms");
  });

  it("says UTC when no time zone is configured, so 20:00 isn't mistaken for local time", () => {
    const result: RuleResult = {
      ruleId: "peak_hour_bottleneck",
      severity: "medium",
      subject: "/mcp/",
      metrics: { hourOfDay: 20, timeZone: "UTC", p95: 1160, avgP95: 522, reqs: 40 },
    };
    expect(resolveMessage("en", result).summary).toContain("around 20:00 UTC");
  });

  it("shows rates as percentages and costs as currency", () => {
    const errors = resolveMessage("pt", {
      ruleId: "error_spike",
      severity: "high",
      subject: "POST /tasks",
      metrics: { errorRate: 0.0345, reqs: 200 },
    });
    expect(errors.summary).toContain("3,5% das requisições");

    const cost = resolveMessage("en", {
      ruleId: "ai_cost_spike",
      severity: "medium",
      subject: "ai_calls",
      metrics: { avgCostToday: 0.004, avgCostBefore: 0.0021, callsToday: 50 },
    });
    expect(cost.summary).toContain("US$ 0.004 vs US$ 0.0021");
  });

  it("keeps SQL inside inline code, without letting a backtick break out", () => {
    const { summary } = resolveMessage("en", {
      ruleId: "slow_query",
      severity: "medium",
      subject: "select `x` from t",
      metrics: { meanExecMs: 380.4, calls: 1200 },
    });
    expect(summary).toBe("Slow query (380 ms avg, 1,200 calls): `select 'x' from t`");
  });
});
