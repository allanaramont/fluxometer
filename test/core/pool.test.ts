import { describe, expect, it, vi } from "vitest";

import { getPool, resetPoolForTesting } from "../../src/core/pool.js";

describe("getPool", () => {
  it("warns clearly when DATABASE_URL is missing, instead of failing later with an unrelated Postgres error", () => {
    resetPoolForTesting();
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    try {
      getPool();
      expect(warnings).toContainEqual(expect.stringMatching(/DATABASE_URL/));
    } finally {
      if (originalUrl) process.env.DATABASE_URL = originalUrl;
      resetPoolForTesting();
    }
  });
});
