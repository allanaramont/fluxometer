import type { NextFunction, Request, Response } from "express";
import { trackRequest } from "../core/writer.js";

/** Fixed bucket for requests that never matched a route — the raw path can
 * carry arbitrary user-supplied content (ids, tokens), so it is never used
 * as the metric's route label. */
const UNMATCHED_ROUTE = "<unmatched>";

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
        route: req.route?.path ?? UNMATCHED_ROUTE,
        method: req.method,
        status: res.statusCode,
        durationMs,
        platform: opts?.platform,
      });
    });
    next();
  };
}
