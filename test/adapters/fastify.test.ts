import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { fastifyPlugin } from "../../src/adapters/fastify.js";
import * as writer from "../../src/core/writer.js";

// SKIPPED (excluded in vitest.config.ts) - fastify@5.12.8's `.inject()`
// pulls in light-my-request@6.8.0 (CJS), which does `require("cookie")`;
// its declared `cookie@^2.0.0` ships ESM-only, so Node throws
// ERR_REQUIRE_ESM. Downgrading `cookie` via `overrides` isn't safe -
// light-my-request's own code targets cookie@2's API, incompatible with
// the CJS-friendly cookie@0.x express already uses elsewhere in this
// repo. Tried inlining fastify/light-my-request/cookie through vitest's
// `server.deps.inline` (three separate attempts, same error every time -
// fastify's own internal `require('light-my-request')` stays outside
// Vite's transform graph regardless of what's listed). This is a
// dev-only test dependency problem, not a production code path -
// `fastifyPlugin` itself has no dependency on light-my-request. Re-enable
// once fastify/light-my-request ship a fix upstream.

describe("fastifyPlugin", () => {
  it("calls trackRequest with the route pattern and status after the response is sent", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const app = Fastify();
    app.register(fastifyPlugin);
    app.get("/tasks/:id", async () => "ok");

    await app.inject({ method: "GET", url: "/tasks/42" });

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/tasks/:id", status: 200 }),
    );
  });

  it("buckets an unmatched route under a fixed sentinel instead of leaking the raw url", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const app = Fastify();
    app.register(fastifyPlugin);
    // no route registered for /users/secret-token-abc123

    await app.inject({ method: "GET", url: "/users/secret-token-abc123" });

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "<unmatched>", status: 404 }),
    );
  });
});
