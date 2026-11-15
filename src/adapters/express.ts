import type { NextFunction, Request, Response } from "express";

import { cleanLabel } from "../core/sanitize.js";
import { trackFailure, trackRequest } from "../core/writer.js";

/** Fixed bucket for requests that never matched a route — the raw path can
 * carry arbitrary user-supplied content (ids, tokens), so it is never used
 * as the metric's route label. */
const UNMATCHED_ROUTE = "<unmatched>";

/** What the middleware knows about the matched route once the response is
 * done: the label to record and the route params (for host callbacks). */
export type RouteInfo = {
  route: string;
  params: Record<string, string>;
};

// Only plain `/a/:param/b` patterns can be rebuilt from the URL; regexes,
// wildcards and optional parts keep the label Express reports.
const PLAIN_PATTERN = /^[\w/:.-]*$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The route label (`/api/families/:familyId/agenda`) and its params.
 *
 * `req.route.path` is relative to whatever router the route was registered on,
 * so the mount prefix comes from `req.baseUrl` (two versioned routers mounted
 * at `/api/v1` and `/api/v2` both exposing `/users/:id` must not collapse).
 * `path` can also be a RegExp or an array for `app.get(/re/)` /
 * `app.get(['/a', '/b'])`, so it is coerced to a string.
 *
 * BUT Express restores `req.baseUrl` and `req.params` to the parent's values
 * when an error leaves a router, and an app-level error handler (the usual
 * setup) answers with both gone: the label lost its prefix (`/:familyId/agenda`)
 * and the params were empty, only for failed responses. When the label from
 * `baseUrl` no longer matches the URL actually requested, it is rebuilt from
 * the URL: the mount prefix is the part of the URL before the route's own
 * segments (mount paths are literal), and the params are read from the
 * segments that line up with the `:name` ones.
 */
function routeInfo(req: Request): RouteInfo | undefined {
  const path = req.route?.path as unknown;
  if (path === undefined) return undefined;
  const pathStr = Array.isArray(path) ? path.join(",") : String(path);
  const direct = `${req.baseUrl ?? ""}${pathStr}`;
  const reqParams = (req.params ?? {}) as Record<string, string>;

  const urlPath = String(req.originalUrl ?? req.url ?? "").split("?", 1)[0] ?? "";
  const urlSegments = urlPath.split("/").filter(Boolean);
  const directSegments = direct.split("/").filter(Boolean);

  if (typeof path !== "string" || !PLAIN_PATTERN.test(path)) {
    return { route: direct, params: { ...reqParams } };
  }
  const patternSegments = path.split("/").filter(Boolean);
  if (patternSegments.length > urlSegments.length) {
    return { route: direct, params: { ...reqParams } };
  }

  // The params can be read off the URL whatever happened to req.params (an
  // error handler inside the router sees an empty one, too).
  const tail = urlSegments.slice(urlSegments.length - patternSegments.length);
  const derived: Record<string, string> = {};
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(":")) {
      derived[segment.slice(1)] = safeDecode(tail[index] ?? "");
    }
  });
  const params = { ...derived, ...reqParams };

  // baseUrl still lines up with the URL: keep the label Express built.
  if (directSegments.length === urlSegments.length) {
    return { route: direct, params };
  }
  const prefix = urlSegments.slice(0, urlSegments.length - patternSegments.length);
  return {
    route: `${prefix.length > 0 ? `/${prefix.join("/")}` : ""}${path}`,
    params,
  };
}

/** The cause of a failed response, handed over by the app's error handler. */
export type FailureCause = {
  name?: string;
  code?: string | number;
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
        /** `info.params` has the route params even when Express already
         * restored `req.params` (an error that left its router). */
        correlationId?: (req: Request, info: RouteInfo) => string | undefined;
        tenant?: (req: Request, info: RouteInfo) => string | undefined;
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
      const info = routeInfo(req);
      const route = info?.route ?? UNMATCHED_ROUTE;
      trackRequest({
        route,
        method: req.method,
        status: res.statusCode,
        durationMs,
        platform: opts?.platform,
      });
      // Unmatched routes are scanner noise, and their raw path can carry
      // tokens: never recorded as failures (same rule as the metric label).
      if (failureOpts && info && res.statusCode >= 400) {
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
          correlationId: safe(() => failureOpts.correlationId?.(req, info)),
          tenant: safe(() => failureOpts.tenant?.(req, info)),
          platform: opts?.platform,
        });
      }
    });
    next();
  };
}
