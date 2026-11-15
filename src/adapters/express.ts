import type { NextFunction, Request, Response } from "express";

import { cleanLabel } from "../core/sanitize.js";
import { trackFailure, trackRequest } from "../core/writer.js";

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

/** The cause of a failed response, handed over by the app's error handler. */
export type FailureCause = {
  name?: string;
  code?: string;
  /** Only stored when `failures.captureMessage` is on; sanitized either way. */
  message?: string;
};

const CAUSE_KEY = "fluxometerFailureCause";

/**
 * Call this from the app's error handler so the failure row says WHY, not just
 * that it failed: `setFailureCause(res, { name: err.name, code: err.code })`.
 */
export function setFailureCause(res: Response, cause: FailureCause): void {
  (res.locals as Record<string, unknown>)[CAUSE_KEY] = cause;
}

export type ExpressMiddlewareOptions = {
  platform?: string;
  /**
   * Failed (4xx/5xx) requests of a matched route are recorded with their
   * cause in `request_failures`. On by default; `false` turns it off.
   * Messages are NOT captured unless `captureMessage` is set.
   */
  failures?:
    | false
    | {
        captureMessage?: boolean;
        correlationId?: (req: Request) => string | undefined;
        tenant?: (req: Request) => string | undefined;
      };
};

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    // A host callback must never break request handling.
    return undefined;
  }
}

export function expressMiddleware(opts?: ExpressMiddlewareOptions) {
  const failureOpts =
    opts?.failures === false ? undefined : (opts?.failures ?? {});
  return function fluxometerExpressMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const route = routeLabel(req);
      trackRequest({
        route,
        method: req.method,
        status: res.statusCode,
        durationMs,
        platform: opts?.platform,
      });
      // Unmatched routes are scanner noise, and their raw path can carry
      // tokens: never recorded as failures (same rule as the metric label).
      if (failureOpts && res.statusCode >= 400 && route !== UNMATCHED_ROUTE) {
        const cause = ((res.locals ?? {}) as Record<string, unknown>)[
          CAUSE_KEY
        ] as FailureCause | undefined;
        trackFailure({
          route,
          method: req.method,
          status: res.statusCode,
          durationMs,
          errorName: cleanLabel(cause?.name),
          errorCode: cleanLabel(cause?.code),
          message: failureOpts.captureMessage ? cause?.message : undefined,
          correlationId: safe(() => failureOpts.correlationId?.(req)),
          tenant: safe(() => failureOpts.tenant?.(req)),
          platform: opts?.platform,
        });
      }
    });
    next();
  };
}
