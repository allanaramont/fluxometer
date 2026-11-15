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

// Quantifiers are bounded: this runs on text that can come straight from a
// request (an error message built from user input), so no pattern may be left
// open-ended on attacker-controlled length.
const EMAIL = /[^\s@<>()[\]",;:]{1,64}@[^\s@<>()[\]",;:]{1,63}(?:\.[^\s@<>()[\]",;:]{1,63}){1,8}/g;

const REDACTIONS: [RegExp, string][] = [
  [EMAIL, "[email]"],
  // secrets written as key=value / key: value, however short
  [
    /\b(?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization|auth)\s*[:=]\s*[^\s,;&"')]{1,200}/gi,
    "[secret]",
  ],
  // well-known key prefixes, however short the rest is
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{6,}|\bxox[abprs]-[A-Za-z0-9-]{6,}|\bAKIA[A-Z0-9]{8,}/g, "[token]"],
  // IPv4 and IPv6
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  // IPv6, including the compressed "::" form; never matches C++-style "a::b"
  [/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, "[ip]"],
  // JWTs (three base64url parts) and "Bearer <token>"
  [/\beyJ[\w-]{5,500}\.[\w-]{5,500}\.[\w-]{5,500}/g, "[token]"],
  [/\bBearer\s+[\w.~+/=-]{1,500}/gi, "Bearer [token]"],
  // URL query strings can carry anything
  [/\?[^\s"')]{0,500}/g, "?[query]"],
  // long opaque tokens / keys
  [/\b[A-Za-z0-9_-]{32,500}\b/g, "[token]"],
  // phones, CPF/CNPJ, card numbers: 9+ digits, with common separators
  [/\b\d[\d .()/-]{7,30}\d\b/g, "[number]"],
];

// Work on a bounded prefix: the regexes below never see more than this, so a
// huge message cannot turn the sanitizer into the slow part of a request.
const SCAN_LIMIT_FACTOR = 4;

export function sanitizeMessage(
  text: string | undefined | null,
  max: number = MAX_MESSAGE_LENGTH,
): string | undefined {
  if (typeof text !== "string") return undefined;
  const limit = max * SCAN_LIMIT_FACTOR;
  let out = (text.length > limit ? text.slice(0, limit) : text).replace(
    /\u0000/g,
    "",
  );
  // A cut can land inside a token (half an API key, half an email) that no
  // pattern would recognise any more: drop the trailing run so a fragment of a
  // secret never survives just because the text was long.
  if (text.length > limit) out = out.replace(/\S+$/, "");
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 0 ? out.slice(0, max) : undefined;
}

/**
 * Strips what Postgres rejects (a NUL byte would make the whole INSERT fail)
 * and redacts e-mail addresses: a label or id is supposed to be opaque, but a
 * host that passes an e-mail as a tenant, an actor or an error name must not
 * end up storing it.
 */
function scrubOpaque(value: string): string {
  return value.replace(/\u0000/g, "").replace(EMAIL, "[email]");
}

/** A short label or id: trimmed, scrubbed and capped. Numbers (an errno, a
 * Mongo error code) are accepted and stored as text. */
export function cleanLabel(
  value: string | number | undefined | null,
  max: number = MAX_NAME_LENGTH,
): string | undefined {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : undefined;
  if (text === undefined) return undefined;
  const out = scrubOpaque(text).trim().slice(0, max);
  return out.length > 0 ? out : undefined;
}

/** A list of names: only non-empty strings, scrubbed, capped in count and length. */
export function cleanNames(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out = values
    .filter((v): v is string => typeof v === "string")
    .map((v) => scrubOpaque(v).trim().slice(0, MAX_NAME_LENGTH))
    .filter((v) => v.length > 0)
    .slice(0, MAX_LIST_ITEMS);
  return out.length > 0 ? out : undefined;
}

/** A count that fits Postgres's int4 instead of failing the whole INSERT. */
export function clampInt4(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(2_147_483_647, Math.max(0, Math.round(value)));
}
