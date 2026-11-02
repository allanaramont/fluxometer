/** A real `Error` subclass (not a plain `{ code, message }` object) so
 * `instanceof Error` checks in consumer code work, and so it logs with a
 * proper stack trace instead of printing as `[object Object]`. */
export class FluxometerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FluxometerError";
    this.code = code;
  }
}

/** For printing a caught error to the CLI's stderr: a typed/real Error's
 * own message is the whole point (it was written for a human to read);
 * dumping the entire object/stack on top of it is noise for the common
 * case, so only values with no usable `message` fall back to that. */
export function describeCliError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    return err.message;
  }
  return String(err);
}
