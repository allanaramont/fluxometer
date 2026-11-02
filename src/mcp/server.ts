import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { whatShouldILookAtToday } from "./tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "fluxometer", version: "0.1.0" });

  server.registerTool(
    "whatShouldILookAtToday",
    {
      description:
        "Returns today's prioritized performance/cost bottlenecks with a suggested fix for each.",
      inputSchema: { locale: z.enum(["en", "es", "pt"]).optional() },
    },
    async ({ locale }) => {
      const result = await whatShouldILookAtToday({ locale });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
