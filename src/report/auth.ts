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
  return a.length === b.length && timingSafeEqual(paddedA, paddedB);
}
