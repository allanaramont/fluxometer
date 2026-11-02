/** Sets or inserts a `KEY=value` line in an existing env-file's contents,
 * leaving every other line untouched. Shared by `init` and `rotate` so
 * neither ever overwrites a `.env` the host app already depends on. */
export function setEnvLine(
  content: string,
  key: string,
  value: string,
): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return content.length > 0 && !content.endsWith("\n")
    ? `${content}\n${line}\n`
    : `${content}${line}\n`;
}

const ENV_COVERING_PATTERNS = new Set([".env", ".env*", "*.env"]);

/** Checks whether a `.gitignore` already covers `.env`, recognizing the
 * common wildcard forms (`.env*`, `*.env`) and a leading-slash anchor —
 * not just an exact `.env` line. A real `.gitignore` glob matcher would
 * handle arbitrary patterns, but these three cover the overwhelming
 * majority of real `.gitignore` files (including this project's own). */
export function isEnvIgnored(gitignoreContent: string): boolean {
  return gitignoreContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .some((line) => ENV_COVERING_PATTERNS.has(line.replace(/^\//, "")));
}
