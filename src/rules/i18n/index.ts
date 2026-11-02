import type { RuleResult } from "../queries.js";
import { CATALOG, type Locale } from "./catalog.js";

export type { Locale };

export function resolveMessage(
  locale: Locale,
  result: RuleResult,
): { summary: string; suggestion: string } {
  const perRule = CATALOG[result.ruleId];
  const messages = perRule[locale] ?? perRule.en;
  return {
    summary: messages.summary(result),
    suggestion: messages.suggestion(result),
  };
}
