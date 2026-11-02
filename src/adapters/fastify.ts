import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { trackRequest } from "../core/writer.js";

/** Fixed bucket for requests that never matched a route — the raw url can
 * carry arbitrary user-supplied content (ids, tokens), so it is never used
 * as the metric's route label. */
const UNMATCHED_ROUTE = "<unmatched>";

function plugin(
  fastify: FastifyInstance,
  opts?: { platform?: string },
  done?: () => void,
): void {
  fastify.addHook("onResponse", async (request, reply) => {
    trackRequest({
      route: request.routeOptions.url ?? UNMATCHED_ROUTE,
      method: request.method,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      platform: opts?.platform,
    });
  });
  done?.();
}

export const fastifyPlugin = fp(plugin, { name: "fluxometer-fastify" });
