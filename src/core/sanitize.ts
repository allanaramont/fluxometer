/**
 * Best-effort scrubbing of free text before it is stored. fluxometer is a
 * library for any app, so nothing that could carry personal data or a secret
 * is kept as typed: emails, tokens, long digit runs (phones, document and
 * card numbers) and URL query strings are replaced, whitespace is collapsed
 * and the text is truncated. It is a safety net, not a guarantee - the safe
 * default is not to capture messages at all.
 */

export const MAX_MESSAGE_LENGTH = 200;
export const MAX_NAME_LENGTH = 64;
const MAX_LIST_ITEMS = 50;

const REDACTIONS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  // JWTs (three base64url parts) and "Bearer <token>"
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "[token]"],
  [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [token]"],
  // URL query strings can carry anything
  [/\?[^\s"')]*/g, "?[query]"],
  // long opaque tokens / keys
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[token]"],
  // phones, CPF/CNPJ, card numbers: 9+ digits, with common separators
  [/\b\d[\d .()/-]{7,}\d\b/g, "[number]"],
];

export function sanitizeMessage(
  text: string | undefined | null,
  max: number = MAX_MESSAGE_LENGTH,
): string | undefined {
  if (typeof text !== "string") return undefined;
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 0 ? out.slice(0, max) : undefined;
}

/** A short label (entity, action, error name...): trimmed and capped. */
export function cleanLabel(
  value: string | undefined | null,
  max: number = MAX_NAME_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.trim().slice(0, max);
  return out.length > 0 ? out : undefined;
}

/** A list of names: only non-empty strings, capped in count and length. */
export function cleanNames(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out = values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().slice(0, MAX_NAME_LENGTH))
    .filter((v) => v.length > 0)
    .slice(0, MAX_LIST_ITEMS);
  return out.length > 0 ? out : undefined;
}
