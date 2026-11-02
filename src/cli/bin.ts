#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../mcp/server.js";
import { parseArgv } from "./argv.js";
import { runInit } from "./init.js";
import { describeRotateResult, runRotate } from "./rotate.js";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { command } = parseArgv(process.argv.slice(2));

  if (command === "init") {
    await runInit({ prompt, env: process.env, fs });
    return;
  }

  if (command === "mcp") {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (command === "rotate") {
    const result = await runRotate({ env: process.env, fs });
    console.log(describeRotateResult(result));
    return;
  }

  console.error(
    `fluxometer: unknown command "${command}". Use one of: init, mcp, rotate`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
