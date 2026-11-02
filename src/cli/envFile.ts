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
