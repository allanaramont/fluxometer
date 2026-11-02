import { Pool } from "pg";
import { runEngine } from "../rules/engine.js";
import { resolveMessage, type Locale } from "../rules/i18n/index.js";

const SUPPORTED_LOCALES: Locale[] = ["en", "es", "pt"];

let pool: Pool | undefined;

function getReadonlyPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.FLUXOMETER_READONLY_URL,
      max: 2,
    });
  }
  return pool;
}

export function setReadonlyPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export type InvalidLocaleError = { code: "invalid_locale"; message: string };

export type WhatShouldILookAtTodayResult = {
  summary: string;
  items: {
    ruleId: string;
    subject: string;
    summary: string;
    suggestion: string;
  }[];
};

export async function whatShouldILookAtToday(input: {
  locale?: Locale;
}): Promise<WhatShouldILookAtTodayResult> {
  const locale = input.locale ?? "en";
  if (!SUPPORTED_LOCALES.includes(locale)) {
    const error: InvalidLocaleError = {
      code: "invalid_locale",
      message: `Unsupported locale: ${String(locale)}`,
    };
    throw error;
  }

  const results = await runEngine(getReadonlyPool());
  const items = results.map((result) => {
    const { summary, suggestion } = resolveMessage(locale, result);
    return {
      ruleId: result.ruleId,
      subject: result.subject,
      summary,
      suggestion,
    };
  });
  const summary =
    items.length > 0 ? `${items.length} issue(s) found` : "No bottleneck today";
  return { summary, items };
}
