import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VoiceBoxError } from "../shared/errors.js";
import {
  isProcessAlive,
  probeDaemon,
  readDaemonState,
  removeDaemonStateFile,
} from "../shared/daemonState.js";
import type { Logger } from "../shared/log.js";
import { ensureHome, getPaths, type VoiceBoxPaths } from "../shared/paths.js";
import type { DaemonState } from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../version.js";

const PROBE_TIMEOUT_MS = 750;
const STARTUP_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 15_000;
const MAX_ATTEMPTS = 5;

export interface DaemonConnection {
  state: DaemonState;
}

/**
 * Find a running daemon, or start exactly one.
 *
 * N clients starting simultaneously is the normal case -- opening four editor
 * windows does it -- so this path is written for contention, not as an edge
 * case. The daemon's own port bind is the real mutex; the lock file here only
 * stops a thundering herd of spawns that would all lose it anyway.
 */
export async function ensureDaemon(logger: Logger): Promise<DaemonConnection> {
  const paths = await ensureHome(getPaths());

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await findLiveDaemon(paths, logger);
    if (existing) return { state: existing };

    if (acquireSpawnLock(paths)) {
      try {
        spawnDaemon(logger, paths);
        const started = await waitForDaemon(paths, STARTUP_TIMEOUT_MS);
        if (started) return { state: started };
        logger.warn("daemon did not become healthy in time");
      } finally {
        releaseSpawnLock(paths);
      }
    } else {
      // Someone else is starting it. Wait for them rather than piling on.
      const started = await waitForDaemon(paths, STARTUP_TIMEOUT_MS);
      if (started) return { state: started };
      breakStaleSpawnLock(paths, logger);
    }
  }

  throw new VoiceBoxError("daemon_unavailable", "Could not start the Voice Box daemon.", {
    hint: "Run `voice-box daemon` in a terminal to see why it is failing.",
  });
}

/**
 * Return the recorded daemon only if it is genuinely alive and speaks our
 * protocol. Anything else is cleaned up so the next step can start fresh.
 */
async function findLiveDaemon(paths: VoiceBoxPaths, logger: Logger): Promise<DaemonState | null> {
  const state = await readDaemonState(paths);
  if (!state) return null;

  const health = await probeDaemon(state.host, state.port, PROBE_TIMEOUT_MS);
  if (!health) {
    // Only reap once we are confident nothing is there: a live-but-hung daemon
    // must not have its state file deleted out from under it.
    if (!isProcessAlive(state.pid)) {
      logger.debug("reaping stale daemon state", { pid: state.pid });
      await removeDaemonStateFile(paths);
      return null;
    }
    throw new VoiceBoxError("daemon_unavailable", "The Voice Box daemon is not responding.", {
      hint: "Run `voice-box restart`.",
    });
  }

  if (majorOf(health.protocolVersion) !== majorOf(PROTOCOL_VERSION)) {
    logger.info("daemon speaks a different protocol; asking it to restart", {
      daemon: health.protocolVersion,
      client: PROTOCOL_VERSION,
    });
    await requestRestart(state).catch(() => {});
    await removeDaemonStateFile(paths);
    return null;
  }

  return state;
}

function majorOf(version: number): number {
  return Math.trunc(version);
}

async function requestRestart(state: DaemonState): Promise<void> {
  await fetch(`http://${state.host}:${state.port}/v1/admin/restart`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.token}`,
      "x-requested-with": "voice-box",
    },
  });
}

/**
 * Start the daemon detached, from the very code that is running now.
 *
 * Resolving the entry from import.meta.url rather than re-invoking `npx`
 * guarantees the same version, from the same cache, with no network access and
 * no second download.
 */
function spawnDaemon(logger: Logger, paths: VoiceBoxPaths): void {
  const compiled = fileURLToPath(new URL("../cli.js", import.meta.url));
  const entry = existsSync(compiled) ? compiled : process.argv[1];

  if (!entry) {
    throw new VoiceBoxError("daemon_unavailable", "Could not locate the Voice Box entry point.");
  }

  // Send the detached daemon's output to the log file rather than /dev/null,
  // otherwise a daemon that fails to start leaves no evidence at all.
  let out: number | "ignore" = "ignore";
  try {
    out = openSync(paths.logFile, "a", 0o600);
  } catch {
    /* fall back to discarding output rather than failing to start */
  }

  // Preserving execArgv keeps loaders such as tsx in play when running from source.
  const child = spawn(process.execPath, [...process.execArgv, entry, "daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (typeof out === "number") closeSync(out);
  logger.debug("spawned daemon", { entry, pid: child.pid });
}

async function waitForDaemon(paths: VoiceBoxPaths, timeoutMs: number): Promise<DaemonState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readDaemonState(paths);
    if (state && (await probeDaemon(state.host, state.port, PROBE_TIMEOUT_MS))) {
      return state;
    }
    await sleep(120);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Spawn lock (advisory only) --------------------------------------------

function acquireSpawnLock(paths: VoiceBoxPaths): boolean {
  try {
    const fd = openSync(paths.lockFile, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseSpawnLock(paths: VoiceBoxPaths): void {
  try {
    unlinkSync(paths.lockFile);
  } catch {
    /* already gone */
  }
}

/** Clear a lock whose owner died or that is simply too old to be real. */
function breakStaleSpawnLock(paths: VoiceBoxPaths, logger: Logger): void {
  try {
    const raw = JSON.parse(readFileSync(paths.lockFile, "utf8")) as { pid?: number; at?: number };
    const ownerDead = typeof raw.pid === "number" && !isProcessAlive(raw.pid);
    const tooOld = typeof raw.at === "number" && Date.now() - raw.at > LOCK_STALE_MS;
    if (ownerDead || tooOld) {
      logger.debug("breaking stale spawn lock", { ownerDead, tooOld });
      releaseSpawnLock(paths);
    }
  } catch {
    releaseSpawnLock(paths);
  }
}
