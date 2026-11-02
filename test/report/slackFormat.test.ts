import { describe, expect, it, vi } from "vitest";

import { formatSlackReport } from "../../src/report/slackFormat.js";
import { postToSlack } from "../../src/report/slackSend.js";
import type { RuleResult } from "../../src/rules/queries.js";

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

  it("localizes the 'Suggestion:' label itself, not just the rule text", () => {
    const results: RuleResult[] = [
      {
        ruleId: "slow_route",
        severity: "high",
        subject: "/x",
        metrics: { p95: 900 },
      },
    ];
    const pt = formatSlackReport(results, "pt");
    expect(pt).not.toContain("Suggestion:");
    expect(pt).toContain("Sugestão:");

    const es = formatSlackReport(results, "es");
    expect(es).not.toContain("Suggestion:");
    expect(es).toContain("Sugerencia:");
  });

  it("caps the report at a bounded number of lines instead of growing unbounded (Slack truncates text at 40k chars)", () => {
    const manyResults: RuleResult[] = Array.from({ length: 30 }, (_, i) => ({
      ruleId: "peak_hour_bottleneck" as const,
      severity: "medium" as const,
      subject: `/route-${i}`,
      metrics: { hourOfDay: i, p95: 900, avgP95: 300, reqs: 50 },
    }));

    const text = formatSlackReport(manyResults, "en");

    const numberedLines = text
      .split("\n")
      .filter((line) => /^\d+\./.test(line));
    expect(numberedLines.length).toBeLessThanOrEqual(15);
    expect(text).toMatch(/15 more/);
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

  it("throws when Slack rejects the webhook, instead of resolving as if it worked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("invalid_token", { status: 404 }),
    );
    await expect(
      postToSlack("https://hooks.slack.com/services/revoked", "hello"),
    ).rejects.toThrow(/404/);
  });
});
