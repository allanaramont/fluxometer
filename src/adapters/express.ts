import type { NextFunction, Request, Response } from "express";

import { trackRequest } from "../core/writer.js";

/** Fixed bucket for requests that never matched a route — the raw path can
 * carry arbitrary user-supplied content (ids, tokens), so it is never used
 * as the metric's route label. */
const UNMATCHED_ROUTE = "<unmatched>";

/** `req.route.path` is relative to whatever router the route was
 * registered on — two versioned routers mounted at different prefixes
 * (`app.use('/api/v1', r1)` / `app.use('/api/v2', r2)`) both exposing
 * `/users/:id` would otherwise collapse into the same metric. `baseUrl`
 * carries the mount prefix. `path` can also be a RegExp or an array for
 * `app.get(/re/)` / `app.get(['/a', '/b'])`, so it's coerced to a string
 * rather than assumed to already be one. */
function routeLabel(req: Request): string {
  const path = req.route?.path as unknown;
  if (path === undefined) return UNMATCHED_ROUTE;
  const pathStr = Array.isArray(path) ? path.join(",") : String(path);
  return `${req.baseUrl ?? ""}${pathStr}`;
}

export function expressMiddleware(opts?: { platform?: string }) {
  return function fluxometerExpressMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      trackRequest({
        route: routeLabel(req),
        method: req.method,
        status: res.statusCode,
        durationMs,
        platform: opts?.platform,
      });
    });
    next();
  };
}
