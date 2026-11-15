import { describe, expect, it } from "vitest";

import {
  clampInt4,
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

describe("sanitizeMessage - secrets and addresses", () => {
  it("redacts key=value secrets however short", () => {
    expect(sanitizeMessage("login failed password=hunter2 for x")).toBe(
      "login failed [secret] for x",
    );
    expect(sanitizeMessage("bad token: abc")).toBe("bad [secret]");
    expect(sanitizeMessage("api_key=zz&next=1")).toBe("[secret]&next=1");
  });

  it("redacts well-known key prefixes even when short", () => {
    expect(sanitizeMessage("key sk_live_abc123XYZ rejected")).toBe(
      "key [token] rejected",
    );
    expect(sanitizeMessage("ghp_abcdef123456 revoked")).toBe("[token] revoked");
    expect(sanitizeMessage("AKIAABCDEFGH1234 denied")).toBe("[token] denied");
  });

  it("redacts IPv4 and IPv6 addresses", () => {
    expect(sanitizeMessage("from 192.168.10.7 refused")).toBe(
      "from [ip] refused",
    );
    expect(sanitizeMessage("from 2001:db8:85a3::8a2e:370:7334 refused")).toBe(
      "from [ip] refused",
    );
  });

  it("does not mangle ordinary text that contains colons", () => {
    expect(sanitizeMessage("TypeError in std::string at line 3")).toBe(
      "TypeError in std::string at line 3",
    );
  });

  it("redacts emails with plus, uppercase, subdomains and unicode", () => {
    expect(sanitizeMessage("Ana+tag@Mail.Example.CO.uk")).toBe("[email]");
    expect(sanitizeMessage("josé@exemplo.com.br falhou")).toBe("[email] falhou");
  });

  it("strips NUL bytes that would make Postgres reject the row", () => {
    expect(sanitizeMessage("a\u0000b")).toBe("ab");
  });
});

describe("sanitizeMessage on hostile input", () => {
  it("stays fast on very large and pathological input", () => {
    const inputs = [
      "a@".repeat(500_000),
      "1 ".repeat(500_000),
      "a.".repeat(500_000) + "@",
      "?".repeat(1_000_000),
      "Bearer " + "x".repeat(1_000_000),
      "eyJ" + "a".repeat(500_000) + "." + "b".repeat(500_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      sanitizeMessage(input);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it("never lets a fragment of a secret survive just because the text was long", () => {
    const key = "sk_live_" + "A1b2C3d4".repeat(6); // 56 chars
    // the cut (4 * 200 = 800) lands in the middle of the key
    const text = "x ".repeat(397) + key + " tail";
    const out = sanitizeMessage(text)!;
    expect(out).not.toMatch(/A1b2C3d4/);
  });

  it("is bounded in what it returns", () => {
    expect(sanitizeMessage("word ".repeat(100_000))).toHaveLength(
      MAX_MESSAGE_LENGTH,
    );
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

  it("redacts an e-mail used as an id or label and strips NUL", () => {
    expect(cleanLabel("ana@example.com", 128)).toBe("[email]");
    expect(cleanLabel("tenant\u0000-1")).toBe("tenant-1");
    expect(cleanNames(["name", "ana@example.com"])).toEqual(["name", "[email]"]);
  });

  it("accepts numeric codes as text and ignores non-finite numbers", () => {
    expect(cleanLabel(11000)).toBe("11000");
    expect(cleanLabel(Number.NaN)).toBeUndefined();
  });

  it("keeps only non-empty string names, capped in count and length", () => {
    expect(cleanNames(["a", " ", 3, "b"])).toEqual(["a", "b"]);
    expect(cleanNames(Array.from({ length: 80 }, (_, i) => `f${i}`))).toHaveLength(50);
    expect(cleanNames(["x".repeat(200)])?.[0]).toHaveLength(64);
    expect(cleanNames([])).toBeUndefined();
    expect(cleanNames("nope")).toBeUndefined();
  });
});

describe("clampInt4", () => {
  it("clamps to the Postgres int4 range and rejects non-numbers", () => {
    expect(clampInt4(1e10)).toBe(2_147_483_647);
    expect(clampInt4(-5)).toBe(0);
    expect(clampInt4(2.6)).toBe(3);
    expect(clampInt4(Number.NaN)).toBeNull();
    expect(clampInt4(undefined)).toBeNull();
  });
});
