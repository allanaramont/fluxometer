import { timingSafeEqual } from "node:crypto";

export function verifyCronSecret(
  headerValue: string | undefined,
  expected: string,
): boolean {
  const a = Buffer.from(headerValue ?? "");
  const b = Buffer.from(expected);
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  // timingSafeEqual runs unconditionally (same cost whether lengths match
  // or not) and is evaluated first — the length check is just a final
  // boolean AND, not an early-out that would skip the constant-time
  // comparison for a mismatched length.
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}
