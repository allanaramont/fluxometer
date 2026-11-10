import { Pool } from "pg";

import { FluxometerError } from "../core/errors.js";
import {
  checkReportHealth,
  describeStaleCause,
  sanitizeErrorDetail,
  staleHeadline,
} from "../report/health.js";
import { runEngine } from "../rules/engine.js";
import { type Locale,resolveMessage } from "../rules/i18n/index.js";

const SUPPORTED_LOCALES: Locale[] = ["en", "es", "pt"];

let pool: Pool | undefined;

function getReadonlyPool(): Pool {
  if (!pool) {
    if (!process.env.FLUXOMETER_READONLY_URL) {
      throw new FluxometerError(
        "missing_readonly_url",
        "FLUXOMETER_READONLY_URL is not set. Run `npx fluxometer init` (or set it manually) before asking fluxometer anything.",
      );
    }
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

export function resetReadonlyPoolForTesting(): void {
  pool = undefined;
}

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
    throw new FluxometerError(
      "invalid_locale",
      `Unsupported locale: ${String(locale)}`,
    );
  }

  const readonlyPool = getReadonlyPool();
  const results = await runEngine(readonlyPool);
  const items: WhatShouldILookAtTodayResult["items"] = results.map((result) => {
    const { summary, suggestion } = resolveMessage(locale, result);
    return {
      ruleId: result.ruleId,
      subject: result.subject,
      summary,
      suggestion,
    };
  });
  // A daily report that stopped arriving is listed first: every other
  // answer here depends on the same data pipeline being healthy.
  try {
    const health = await checkReportHealth(readonlyPool);
    if (health.stale) {
      items.unshift({
        ruleId: "report_not_running",
        subject: "daily report",
        summary: staleHeadline(health, locale),
        suggestion: describeStaleCause(health, locale, false),
      });
    }
  } catch (err) {
    console.warn(
      "fluxometer: could not check the daily report's health (older schema, or the read-only role can't read fluxometer.report_runs)",
      sanitizeErrorDetail(err),
    );
  }

  const summary =
    items.length > 0 ? `${items.length} issue(s) found` : "No bottleneck today";
  return { summary, items };
}
