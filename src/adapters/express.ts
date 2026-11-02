import type { NextFunction, Request, Response } from "express";
import { trackRequest } from "../core/writer.js";

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
        route: req.route?.path ?? req.path,
        method: req.method,
        status: res.statusCode,
        durationMs,
        platform: opts?.platform,
      });
    });
    next();
  };
}
