import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import * as writer from "../../src/core/writer.js";
import { expressMiddleware } from "../../src/adapters/express.js";

describe("expressMiddleware", () => {
  it("calls trackRequest with normalized route, status and duration after the response finishes", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const app = express();
    app.use(expressMiddleware());
    app.get("/tasks/:id", (_req, res) => {
      res.status(200).send("ok");
    });

    await request(app).get("/tasks/42");
    await new Promise((resolve) => setImmediate(resolve)); // let 'finish' handler run

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/tasks/:id", status: 200 }),
    );
  });

  it("buckets an unmatched route under a fixed sentinel instead of leaking the raw path", async () => {
    const trackSpy = vi
      .spyOn(writer, "trackRequest")
      .mockImplementation(() => {});
    const app = express();
    app.use(expressMiddleware());
    // no route registered for /users/secret-token-abc123

    await request(app).get("/users/secret-token-abc123");
    await new Promise((resolve) => setImmediate(resolve));

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: "<unmatched>", status: 404 }),
    );
  });
});
