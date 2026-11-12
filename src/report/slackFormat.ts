import { type Locale,resolveMessage } from "../rules/i18n/index.js";
import type { RuleResult } from "../rules/queries.js";

const NO_BOTTLENECK_TEXT: Record<Locale, string> = {
  en: "No bottleneck in the last 24h.",
  pt: "Sem gargalo nas últimas 24h.",
  es: "Sin cuello de botella en las últimas 24h.",
};

const HEADER_TEXT: Record<Locale, string> = {
  en: "Performance in the last 24h",
  pt: "Performance nas últimas 24h",
  es: "Rendimiento en las últimas 24h",
};

/** Incoming webhooks post under whatever name the Slack app was given (often
 * none), so the message itself says what it is and which app it's about. */
function header(locale: Locale, appName?: string): string {
  const title = HEADER_TEXT[locale] ?? HEADER_TEXT.en;
  const app = appName?.trim();
  return app
    ? `:bar_chart: *fluxometer · ${app}* — ${title}`
    : `:bar_chart: *fluxometer* — ${title}`;
}

const SUGGESTION_LABEL: Record<Locale, string> = {
  en: "Suggestion:",
  pt: "Sugestão:",
  es: "Sugerencia:",
};

const AND_MORE_TEXT: Record<Locale, (n: number) => string> = {
  en: (n) => `...and ${n} more.`,
  pt: (n) => `...e mais ${n}.`,
  es: (n) => `...y ${n} más.`,
};

/** Slack truncates an incoming-webhook `text` payload around 40,000
 * characters. A rule like peak_hour_bottleneck can in principle emit one
 * result per route per anomalous hour over 7 days — capping the report
 * at a fixed number of lines keeps it readable and keeps it under that
 * limit regardless of how many results the engine returns. */
const MAX_REPORTED_LINES = 15;

export type SlackReportOptions = {
  /** Shown in the header, e.g. "fluxometer · Fluxo Casa". */
  appName?: string;
};

export function formatSlackReport(
  results: RuleResult[],
  locale: Locale,
  options: SlackReportOptions = {},
): string {
  const top = header(locale, options.appName);
  if (results.length === 0) {
    return `${top}\n:white_check_mark: ${NO_BOTTLENECK_TEXT[locale] ?? NO_BOTTLENECK_TEXT.en}`;
  }
  const suggestionLabel = SUGGESTION_LABEL[locale] ?? SUGGESTION_LABEL.en;
  const shown = results.slice(0, MAX_REPORTED_LINES);
  const lines = shown.map((result, index) => {
    const { summary, suggestion } = resolveMessage(locale, result);
    return `${index + 1}. ${summary}\n      _${suggestionLabel}_ ${suggestion}`;
  });
  const omitted = results.length - shown.length;
  if (omitted > 0) {
    const andMore = AND_MORE_TEXT[locale] ?? AND_MORE_TEXT.en;
    lines.push(andMore(omitted));
  }
  return [top, ...lines].join("\n");
}
