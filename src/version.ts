import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read from package.json rather than hardcoding: v1 advertised "1.0.0" over MCP
// while package.json said 1.0.2, which made version reports useless.
// The relative path is the same from dist/version.js and src/version.ts.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  name?: string;
  version?: string;
};

export const PKG_NAME = pkg.name ?? "@anomalypoint/voice-box";
export const PKG_VERSION = pkg.version ?? "0.0.0";

/**
 * Wire-compatibility version for the MCP-client <-> daemon HTTP protocol.
 * Bump only on a breaking change; the client restarts a daemon whose major
 * differs from its own so the newest client always wins.
 */
export const PROTOCOL_VERSION = 1;

/** Package root on disk (the directory containing package.json). */
export const PKG_ROOT = join(here, "..");
