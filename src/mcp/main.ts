import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLogger } from "../shared/log.js";
import { PKG_VERSION } from "../version.js";
import { AgentConnection } from "./connection.js";
import { registerTools } from "./tools.js";

/**
 * Run the MCP stdio server.
 *
 * This process is deliberately thin: it owns no audio device and no queue. It
 * derives an identity, talks to the one daemon on this machine, and gets out of
 * the way -- which is what stops several agents from talking over each other.
 *
 * Everything diagnostic goes to stderr; stdout carries JSON-RPC frames.
 */
export async function runMcpServer(): Promise<void> {
  const logger = createLogger({ scope: "mcp" });

  const server = new McpServer({ name: "voice-box", version: PKG_VERSION });

  // Registration is lazy, so the client's name from `initialize` is available
  // by the time the agent first speaks.
  const connection = new AgentConnection(() => {
    const info = server.server.getClientVersion();
    return info ? { name: info.name, version: info.version } : undefined;
  }, logger);

  registerTools(server, connection, logger);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("voice-box MCP server ready", { version: PKG_VERSION });

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    logger.info("shutting down", { reason });
    await connection.close();
    await server.close().catch(() => {});
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  // The client closing the pipe is the normal end of an MCP session.
  process.stdin.once("end", () => void shutdown("stdin closed"));
}
