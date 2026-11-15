import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expressMiddleware,
  setFailureCause,
} from "../../src/adapters/express.js";
import * as writer from "../../src/core/writer.js";

afterEach(() => vi.restoreAllMocks());

function appWith(options?: Parameters<typeof expressMiddleware>[0]) {
  vi.spyOn(writer, "trackRequest").mockImplementation(() => {});
  const failure = vi.spyOn(writer, "trackFailure").mockImplementation(() => {});
  const app = express();
  app.use(expressMiddleware(options));
  return { app, failure };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("expressMiddleware failures", () => {
  it("records a failed request of a matched route with the cause the handler set", async () => {
    const { app, failure } = appWith({
      failures: { captureMessage: true, tenant: () => "family-1" },
    });
    app.get("/pets/:petId", (_req, res) => {
      setFailureCause(res, {
        name: "AppError",
        code: "FORBIDDEN",
        message: "You are not a member of this family",
      });
      res.status(403).send("no");
    });
    await request(app).get("/pets/42");
    await settle();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "/pets/:petId",
        status: 403,
        errorName: "AppError",
        errorCode: "FORBIDDEN",
        message: "You are not a member of this family",
        tenant: "family-1",
      }),
    );
  });

  it("does NOT capture the message unless asked (privacy by default)", async () => {
    const { app, failure } = appWith();
    app.get("/x", (_req, res) => {
      setFailureCause(res, { name: "AppError", message: "secret detail" });
      res.status(400).send("bad");
    });
    await request(app).get("/x");
    await settle();
    const call = failure.mock.calls[0][0];
    expect(call.errorName).toBe("AppError");
    expect(call.message).toBeUndefined();
  });

  it("still records a failure the handler gave no cause for (status + route)", async () => {
    const { app, failure } = appWith();
    app.get("/x", (_req, res) => {
      res.status(401).send("no");
    });
    await request(app).get("/x");
    await settle();
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/x", status: 401 }),
    );
  });

  it("records nothing for a successful request", async () => {
    const { app, failure } = appWith();
    app.get("/x", (_req, res) => {
      res.status(200).send("ok");
    });
    await request(app).get("/x");
    await settle();
    expect(failure).not.toHaveBeenCalled();
  });

  it("never records a failure for an unmatched route (scanner noise, raw path may carry tokens)", async () => {
    const { app, failure } = appWith();
    await request(app).get("/users/secret-token-abc123");
    await settle();
    expect(failure).not.toHaveBeenCalled();
  });

  it("can be turned off", async () => {
    const { app, failure } = appWith({ failures: false });
    app.get("/x", (_req, res) => {
      res.status(500).send("boom");
    });
    await request(app).get("/x");
    await settle();
    expect(failure).not.toHaveBeenCalled();
  });

  it("survives a throwing host callback", async () => {
    const { app, failure } = appWith({
      failures: {
        correlationId: () => {
          throw new Error("callback blew up");
        },
      },
    });
    app.get("/x", (_req, res) => {
      res.status(500).send("boom");
    });
    const response = await request(app).get("/x");
    await settle();
    expect(response.status).toBe(500);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0].correlationId).toBeUndefined();
  });
});
