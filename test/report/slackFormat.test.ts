import { describe, expect, it, vi } from "vitest";
import type { RuleResult } from "../../src/rules/queries.js";
import { formatSlackReport } from "../../src/report/slackFormat.js";
import { postToSlack } from "../../src/report/slackSend.js";

describe("formatSlackReport", () => {
  it("formats a ranked list with summary and suggestion per result", () => {
    const results: RuleResult[] = [
      {
        ruleId: "slow_route",
        severity: "high",
        subject: "/tasks/ai-parse",
        metrics: { p95: 3800 },
      },
    ];
    const text = formatSlackReport(results, "en");
    expect(text).toContain("/tasks/ai-parse");
    expect(text).toMatch(/Performance/i);
  });

  it("says there is nothing to report when the results list is empty", () => {
    expect(formatSlackReport([], "en")).toMatch(/no bottleneck/i);
  });
});

describe("postToSlack", () => {
  it("POSTs the text as the webhook payload", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await postToSlack("https://hooks.slack.com/services/x", "hello");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/x",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
