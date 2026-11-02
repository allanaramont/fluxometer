import { describe, expect, it } from "vitest";

import { resolveMessage } from "../../src/rules/i18n/index.js";
import type { RuleResult } from "../../src/rules/queries.js";

describe("resolveMessage", () => {
  it("resolves slow_route in all three locales with the route interpolated", () => {
    const result: RuleResult = {
      ruleId: "slow_route",
      severity: "high",
      subject: "/tasks/ai-parse",
      metrics: { p95: 3800 },
    };
    expect(resolveMessage("en", result).summary).toContain("/tasks/ai-parse");
    expect(resolveMessage("pt", result).summary).toContain("/tasks/ai-parse");
    expect(resolveMessage("es", result).summary).toContain("/tasks/ai-parse");
  });

  it("falls back to en for an unknown locale instead of throwing", () => {
    expect(() =>
      resolveMessage("fr" as any, {
        ruleId: "slow_route",
        severity: "high",
        subject: "/x",
        metrics: {},
      }),
    ).not.toThrow();
  });
});
