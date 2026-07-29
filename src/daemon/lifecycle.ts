import { randomBytes } from "node:crypto";
import type { RequestListener, Server } from "node:http";
import { createServer } from "node:http";

import {
  claimDaemonStateFile,
  probeDaemon,
  readDaemonState,
  releaseDaemonStateFile,
  removeDaemonStateFile,
} from "../shared/daemonState.js";
import type { Logger } from "../shared/log.js";
import type { VoiceBoxPaths } from "../shared/paths.js";
import type { DaemonState } from "../shared/protocol.js";
import { PKG_VERSION, PROTOCOL_VERSION } from "../version.js";
import { MAX_PORT_ATTEMPTS } from "./config/schema.js";

/** Loopback only. There is intentionally no setting to change this. */
export const BIND_HOST = "127.0.0.1";

export interface ClaimOptions {
  handler: RequestListener;
  /**
   * Pre-built state, mutated in place as the port settles.
   *
   * It is passed in rather than created here so the request handler can read a
   * fully-formed token and port from the moment listen() succeeds. Assigning
   * it afterwards would leave a window in which a probe -- exactly what a
   * racing daemon sends -- could hit an undefined state.
   */
  state: DaemonState;
  configuredPort: number;
  paths: VoiceBoxPaths;
  logger: Logger;
}

/** Build the state a daemon will publish once it wins the port. */
export function createDaemonState(port: number): DaemonState {
  return {
    schemaVersion: 1,
    pid: process.pid,
    port,
    host: BIND_HOST,
    // 256 bits, regenerated per start so a leaked token dies with the process.
    token: randomBytes(32).toString("base64url"),
    pkgVersion: PKG_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
  };
}

export interface DaemonClaim {
  server: Server;
  state: DaemonState;
  /** Stop serving and release the state file if we still own it. */
  release(): Promise<void>;
}

/**
 * Acquire exclusive ownership of the daemon role.
 *
 * The TCP bind is the real lock: it is atomic in the kernel and self-heals the
 * instant a process dies, which no PID file or lockfile can promise. The state
 * file is claimed second, with O_EXCL, purely so the token and port are
 * published atomically.
 *
 * Returns null when another healthy daemon already holds the role -- the
 * correct response to which is to exit(0), not to error.
 */
export async function claimDaemonRole(options: ClaimOptions): Promise<DaemonClaim | null> {
  const { handler, state, configuredPort, paths, logger } = options;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = configuredPort + attempt;
    // Publish the port before binding, so the handler is coherent the instant
    // the socket starts accepting.
    state.port = port;

    const server = createServer(handler);
    const bound = await tryListen(server, port);

    if (!bound) {
      // Something owns this port. If it is one of ours, we lost the race
      // cleanly; if it is unrelated software, step to the next port.
      const existing = await probeDaemon(BIND_HOST, port);
      if (existing) {
        logger.info("another daemon already owns the port", { port, pid: existing.pid });
        return null;
      }
      logger.debug("port in use by another service, trying the next", { port });
      continue;
    }

    const claimed = await claimStateFile(paths, state, logger);
    if (claimed === "lost") {
      await closeServer(server);
      return null;
    }
    if (claimed === "retry") {
      // Stale file removed; re-attempt the claim on this same port.
      await closeServer(server);
      attempt--;
      continue;
    }

    logger.info("daemon listening", { host: BIND_HOST, port, pid: process.pid });
    return {
      server,
      state,
      release: async () => {
        await closeServer(server);
        await releaseDaemonStateFile(paths, process.pid);
      },
    };
  }

  throw new Error(
    `No free port in ${configuredPort}-${configuredPort + MAX_PORT_ATTEMPTS - 1}. ` +
      "Set daemon.port in ~/.voice-box/config.json.",
  );
}

type ClaimResult = "won" | "lost" | "retry";

async function claimStateFile(
  paths: VoiceBoxPaths,
  state: DaemonState,
  logger: Logger,
): Promise<ClaimResult> {
  if (await claimDaemonStateFile(paths, state)) return "won";

  // The file exists. Decide whether it describes a live daemon or a corpse.
  const other = await readDaemonState(paths);
  if (other && (await probeDaemon(other.host, other.port))) {
    logger.info("a healthy daemon is already registered", { pid: other.pid, port: other.port });
    return "lost";
  }

  logger.warn("removing stale daemon state", { staleFile: paths.daemonFile });
  await removeDaemonStateFile(paths);
  return "retry";
}

function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      resolve(false);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, BIND_HOST);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
