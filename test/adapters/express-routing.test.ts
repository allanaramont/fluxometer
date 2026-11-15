import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expressMiddleware } from "../../src/adapters/express.js";
import * as writer from "../../src/core/writer.js";

afterEach(() => vi.restoreAllMocks());

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Express restores req.baseUrl and req.params when an error leaves a router, so
// an app-level error handler (the common setup) answers with both gone. The
// labels and the tenant must not depend on WHERE the response is sent.
function buildApp(errorHandlerInsideRouter = false) {
  const request_ = vi.spyOn(writer, "trackRequest").mockImplementation(() => {});
  const failure = vi.spyOn(writer, "trackFailure").mockImplementation(() => {});
  const app = express();
  app.use(
    expressMiddleware({
      failures: { tenant: (_req, info) => info.params.familyId },
    }),
  );
  const families = express.Router();
  families.get("/:familyId/agenda", (req, res, next) => {
    if (req.query.fail === "next") return next(new Error("boom"));
    if (req.query.fail === "direct") return res.status(403).send("no");
    res.send("ok");
  });
  if (errorHandlerInsideRouter) {
    families.use(((err, _req, res, _next) => {
      res.status(500).send(String(err));
    }) as express.ErrorRequestHandler);
  }
  const api = express.Router();
  api.use("/families", families);
  app.use("/api", api);
  if (!errorHandlerInsideRouter) {
    app.use(((err, _req, res, _next) => {
      res.status(500).send(String(err));
    }) as express.ErrorRequestHandler);
  }
  return { app, request_, failure };
}

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const LABEL = "/api/families/:familyId/agenda";

describe("route label and tenant do not depend on where the response is sent", () => {
  it("success in a nested router: full label", async () => {
    const { app, request_ } = buildApp();
    await request(app).get(`/api/families/${ID}/agenda`);
    await settle();
    expect(request_.mock.calls[0][0].route).toBe(LABEL);
  });

  it("a response sent directly by the handler keeps the label and the tenant", async () => {
    const { app, request_, failure } = buildApp();
    await request(app).get(`/api/families/${ID}/agenda?fail=direct`);
    await settle();
    expect(request_.mock.calls[0][0].route).toBe(LABEL);
    expect(failure.mock.calls[0][0]).toMatchObject({ route: LABEL, tenant: ID });
  });

  it("an error that leaves the router for an APP-level handler keeps label and tenant", async () => {
    const { app, request_, failure } = buildApp();
    await request(app).get(`/api/families/${ID}/agenda?fail=next`);
    await settle();
    expect(request_.mock.calls[0][0].route).toBe(LABEL);
    expect(failure.mock.calls[0][0]).toMatchObject({
      route: LABEL,
      status: 500,
      tenant: ID,
    });
  });

  it("an error handled by a router-level handler keeps label and tenant", async () => {
    const { app, failure } = buildApp(true);
    await request(app).get(`/api/families/${ID}/agenda?fail=next`);
    await settle();
    expect(failure.mock.calls[0][0]).toMatchObject({ route: LABEL, tenant: ID });
  });

  it("never puts a raw id in the label", async () => {
    const { app, request_ } = buildApp();
    await request(app).get(`/api/families/${ID}/agenda?fail=next`);
    await settle();
    expect(request_.mock.calls[0][0].route).not.toContain(ID);
  });
});
