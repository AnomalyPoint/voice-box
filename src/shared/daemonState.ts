import { open, unlink, readFile } from "node:fs/promises";
import { z } from "zod";

import { SECRET_FILE_MODE, type VoiceBoxPaths } from "./paths.js";
import { API_PREFIX, SERVICE_NAME, type DaemonState, type HealthResponse } from "./protocol.js";

const daemonStateSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  token: z.string().min(16),
  pkgVersion: z.string(),
  protocolVersion: z.number().int(),
  startedAt: z.string(),
});

/**
 * Read the daemon coordinates.
 *
 * Always tolerant: this file is regenerable runtime state, so a truncated or
 * hand-edited one should be treated as "no daemon" rather than a hard error.
 */
export async function readDaemonState(paths: VoiceBoxPaths): Promise<DaemonState | null> {
  try {
    const raw = await readFile(paths.daemonFile, "utf8");
    const parsed = daemonStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Create the state file only if it does not exist ('wx').
 * Returns false when another daemon got there first.
 */
export async function claimDaemonStateFile(
  paths: VoiceBoxPaths,
  state: DaemonState,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(paths.daemonFile, "wx", SECRET_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(SECRET_FILE_MODE);
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Remove the state file, but only while it still describes us.
 *
 * Without the ownership check, a slow shutdown could delete the file a
 * successor daemon had already written, leaving clients unable to find it.
 */
export async function releaseDaemonStateFile(
  paths: VoiceBoxPaths,
  pid: number,
): Promise<void> {
  const current = await readDaemonState(paths);
  if (current && current.pid !== pid) return;
  await unlink(paths.daemonFile).catch(() => {});
}

export async function removeDaemonStateFile(paths: VoiceBoxPaths): Promise<void> {
  await unlink(paths.daemonFile).catch(() => {});
}

/** Signal 0 tests for existence without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ask whatever is on this port whether it is a Voice Box daemon.
 *
 * Checking identity rather than "is the port open" is what makes the whole
 * lifecycle safe: an unrelated service on 4517, or a recycled PID, must never
 * be mistaken for a live daemon.
 */
export async function probeDaemon(
  host: string,
  port: number,
  timeoutMs = 750,
): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}${API_PREFIX}/health`, {
      signal: controller.signal,
      headers: { host: `${host}:${port}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthResponse;
    return body?.service === SERVICE_NAME ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

