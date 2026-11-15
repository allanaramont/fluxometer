import { describe, expect, it } from "vitest";

import {
  cleanLabel,
  cleanNames,
  MAX_MESSAGE_LENGTH,
  sanitizeMessage,
} from "../../src/core/sanitize.js";

describe("sanitizeMessage", () => {
  it("redacts emails", () => {
    expect(sanitizeMessage("User ana.souza@example.com not found")).toBe(
      "User [email] not found",
    );
  });

  it("redacts bearer tokens and JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(sanitizeMessage(`Bearer abc.def-123 failed`)).toBe(
      "Bearer [token] failed",
    );
    expect(sanitizeMessage(`bad token ${jwt}`)).toBe("bad token [token]");
  });

  it("redacts long opaque keys", () => {
    expect(
      sanitizeMessage("key sk_live_" + "a1B2c3D4".repeat(5) + " rejected"),
    ).toBe("key [token] rejected");
  });

  it("redacts long digit runs (phones, documents, cards) but keeps short numbers", () => {
    expect(sanitizeMessage("cpf 123.456.789-09 invalid")).toBe(
      "cpf [number] invalid",
    );
    expect(sanitizeMessage("card 4111 1111 1111 1111 declined")).toBe(
      "card [number] declined",
    );
    expect(sanitizeMessage("retry 3 of 5, status 404")).toBe(
      "retry 3 of 5, status 404",
    );
  });

  it("strips URL query strings", () => {
    expect(sanitizeMessage("GET /x?token=abc&id=9 failed")).toBe(
      "GET /x?[query] failed",
    );
  });

  it("collapses whitespace and truncates", () => {
    expect(sanitizeMessage("a   b\n\nc")).toBe("a b c");
    expect(sanitizeMessage("word ".repeat(100))).toHaveLength(MAX_MESSAGE_LENGTH);
    // one long unbroken run is an opaque token, not text
    expect(sanitizeMessage("x".repeat(500))).toBe("[token]");
  });

  it("returns undefined for empty or non-string input", () => {
    expect(sanitizeMessage("   ")).toBeUndefined();
    expect(sanitizeMessage(undefined)).toBeUndefined();
    expect(sanitizeMessage(null)).toBeUndefined();
  });
});

describe("cleanLabel / cleanNames", () => {
  it("trims and caps a label, rejecting empty and non-strings", () => {
    expect(cleanLabel("  Pet  ")).toBe("Pet");
    expect(cleanLabel("x".repeat(100))).toHaveLength(64);
    expect(cleanLabel("x".repeat(300), 128)).toHaveLength(128);
    expect(cleanLabel("")).toBeUndefined();
    expect(cleanLabel(undefined)).toBeUndefined();
  });

  it("keeps only non-empty string names, capped in count and length", () => {
    expect(cleanNames(["a", " ", 3, "b"])).toEqual(["a", "b"]);
    expect(cleanNames(Array.from({ length: 80 }, (_, i) => `f${i}`))).toHaveLength(50);
    expect(cleanNames(["x".repeat(200)])?.[0]).toHaveLength(64);
    expect(cleanNames([])).toBeUndefined();
    expect(cleanNames("nope")).toBeUndefined();
  });
});
