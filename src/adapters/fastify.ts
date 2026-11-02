import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { trackRequest } from "../core/writer.js";

function plugin(
  fastify: FastifyInstance,
  opts?: { platform?: string },
  done?: () => void,
): void {
  fastify.addHook("onResponse", async (request, reply) => {
    trackRequest({
      route: request.routeOptions.url ?? request.url,
      method: request.method,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      platform: opts?.platform,
    });
  });
  done?.();
}

export const fastifyPlugin = fp(plugin, { name: "fluxometer-fastify" });
