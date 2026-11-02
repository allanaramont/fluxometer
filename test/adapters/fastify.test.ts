import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import * as writer from "../../src/core/writer.js";
import { fastifyPlugin } from "../../src/adapters/fastify.js";

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
