import { describe, expect, it } from "vitest";

import { describeCliError, FluxometerError } from "../../src/core/errors.js";

describe("FluxometerError", () => {
  it("is a real Error (instanceof Error) that also carries a typed code", () => {
    const err = new FluxometerError(
      "missing_database_url",
      "DATABASE_URL is not set",
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      code: "missing_database_url",
      message: "DATABASE_URL is not set",
    });
  });
});

describe("describeCliError", () => {
  it("prints just the message for a FluxometerError, not the whole object", () => {
    const err = new FluxometerError(
      "missing_database_url",
      "DATABASE_URL is not set. Set it and try again.",
    );
    expect(describeCliError(err)).toBe(
      "DATABASE_URL is not set. Set it and try again.",
    );
  });

  it("prints just the message for a plain object that has one, for backward compatibility", () => {
    expect(describeCliError({ code: "x", message: "something clear" })).toBe(
      "something clear",
    );
  });

  it("falls back to a string dump when there is no usable message", () => {
    expect(describeCliError("boom")).toBe("boom");
  });
});
