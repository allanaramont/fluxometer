import type { Locale } from "./i18n/catalog.js";

const LOCALE_TAG: Record<Locale, string> = {
  en: "en-US",
  pt: "pt-BR",
  es: "es-ES",
};

function tag(locale: Locale): string {
  return LOCALE_TAG[locale] ?? LOCALE_TAG.en;
}

function toNumber(value: number | string | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Durations come straight out of Postgres aggregates (`618.560713`,
 * `522.4849999999999`) — whole milliseconds with a thousands separator
 * are all a reader needs. */
export function ms(value: number | string | undefined, locale: Locale): string {
  return `${Math.round(toNumber(value)).toLocaleString(tag(locale))} ms`;
}

/** Rates are stored as fractions (0.034) and read as percentages (3.4%). */
export function pct(value: number | string | undefined, locale: Locale): string {
  const percent = toNumber(value) * 100;
  return `${percent.toLocaleString(tag(locale), {
    maximumFractionDigits: percent < 10 ? 1 : 0,
  })}%`;
}

export function usd(value: number | string | undefined, locale: Locale): string {
  return `US$ ${toNumber(value).toLocaleString(tag(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function count(
  value: number | string | undefined,
  locale: Locale,
): string {
  return Math.round(toNumber(value)).toLocaleString(tag(locale));
}

/** Route templates and SQL go inside Slack/Markdown inline code so they
 * stand apart from the sentence and SQL doesn't get mangled by formatting. */
export function code(value: number | string | undefined): string {
  return `\`${String(value ?? "").replace(/`/g, "'")}\``;
}

/** An hour of the day as "17:00", with " UTC" appended when no local
 * time zone was configured, so a reader never mistakes UTC for local time. */
export function hourOfDay(
  hour: number | string | undefined,
  timeZone: number | string | undefined,
): string {
  const h = String(Math.round(toNumber(hour)) % 24).padStart(2, "0");
  const zone = String(timeZone ?? "UTC");
  return zone === "UTC" ? `${h}:00 UTC` : `${h}:00`;
}

/** The time zone used to bucket "hour of day", from FLUXOMETER_TIMEZONE
 * (an IANA name such as America/Sao_Paulo). Invalid or missing → UTC. */
export function reportTimeZone(): string {
  const value = process.env.FLUXOMETER_TIMEZONE?.trim();
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    console.warn(
      `fluxometer: FLUXOMETER_TIMEZONE="${value}" is not a valid IANA time zone — using UTC.`,
    );
    return "UTC";
  }
}
