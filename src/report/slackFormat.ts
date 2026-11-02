import type { RuleResult } from "../rules/queries.js";
import { resolveMessage, type Locale } from "../rules/i18n/index.js";

const NO_BOTTLENECK_TEXT: Record<Locale, string> = {
  en: "No bottleneck in the last 24h.",
  pt: "Sem gargalo nas últimas 24h.",
  es: "Sin cuello de botella en las últimas 24h.",
};

export function formatSlackReport(
  results: RuleResult[],
  locale: Locale,
): string {
  const header = "*Performance — last 24h*";
  if (results.length === 0) {
    return `${header}\n${NO_BOTTLENECK_TEXT[locale] ?? NO_BOTTLENECK_TEXT.en}`;
  }
  const lines = results.map((result, index) => {
    const { summary, suggestion } = resolveMessage(locale, result);
    return `${index + 1}. ${summary}. Suggestion: ${suggestion}`;
  });
  return [header, ...lines].join("\n");
}
