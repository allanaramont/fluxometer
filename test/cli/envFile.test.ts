import { describe, expect, it } from "vitest";

import { isEnvIgnored } from "../../src/cli/envFile.js";

describe("isEnvIgnored", () => {
  it("recognizes an exact .env line", () => {
    expect(isEnvIgnored(".env\n")).toBe(true);
  });

  it("recognizes common wildcard patterns (.env*, *.env) this repo itself uses", () => {
    expect(isEnvIgnored(".env*\n")).toBe(true);
    expect(isEnvIgnored("*.env\n")).toBe(true);
  });

  it("recognizes a leading-slash-anchored pattern", () => {
    expect(isEnvIgnored("/.env\n")).toBe(true);
  });

  it("returns false when .env isn't covered by anything in the file", () => {
    expect(isEnvIgnored("node_modules\ndist\n")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    expect(isEnvIgnored("# secrets\n\n.env\n")).toBe(true);
  });
});
