#!/usr/bin/env node
/**
 * Dedicated MCP entry point, equivalent to `voice-box mcp`.
 *
 * Having a bin that does exactly one thing means an MCP client config can never
 * accidentally land in a different mode.
 */
import { runMcpServer } from "./mcp/main.js";

runMcpServer().catch((error: unknown) => {
  // stderr only: stdout is the JSON-RPC channel.
  console.error("voice-box: fatal error starting MCP server:", error);
  process.exit(1);
});
