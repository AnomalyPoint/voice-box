import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { VoiceBoxError } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import { voiceBoxHome, SECRET_DIR_MODE } from "../../shared/paths.js";
import type { DetectedBackend } from "./detect.js";
import type { AudioPlayer, PlaybackHandle, PlaybackOutcome } from "./types.js";

const isWindows = process.platform === "win32";

/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 700;
/** mpv creates the IPC socket shortly after spawn; poll until it accepts. */
const CONNECT_RETRY_MS = 50;
const CONNECT_DEADLINE_MS = 4_000;
/** Bound stderr capture so a chatty player cannot balloon memory. */
const MAX_STDERR_BYTES = 8 * 1024;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

let playCounter = 0;

/**
 * Sockets live under ~/.voice-box/run (0700), not the shared /tmp: mpv's IPC
 * accepts commands like `run`, so on a multi-user Linux box a world-readable
 * socket would be command execution as the daemon's user. A private dir also
 * sidesteps stale-socket collisions from a crashed daemon with a recycled pid.
 */
function socketPathFor(sequence: number): string {
  if (isWindows) return `\\\\.\\pipe\\vb-mpv-${process.pid}-${sequence}`;
  const runDir = join(voiceBoxHome(), "run");
  mkdirSync(runDir, { recursive: true, mode: SECRET_DIR_MODE });
  const path = join(runDir, `mpv-${process.pid}-${sequence}.sock`);
  rmSync(path, { force: true });
  return path;
}

/**
 * One-shot capability check: an mpv old enough to lack `--input-ipc-server`
 * exits non-zero on the unknown option, which would otherwise fail every
 * utterance with no useful diagnostic. Option parsing happens before playback,
 * so `--version` keeps the probe instant and silent.
 */
export function probeMpvIpc(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--no-config", `--input-ipc-server=${socketPathFor(++playCounter)}`, "--version"],
      { timeout: 3_000, windowsHide: true },
      (error) => resolve(error === null),
    );
  });
}

/**
 * mpv driven over its JSON IPC socket.
 *
 * This is the one backend with a real control channel, which buys the two
 * things a spawn-and-wait player cannot do: pausing mid-word without signals
 * (SIGSTOP freezes a CoreAudio client's feeder threads -- the audio stutters,
 * then the HAL tears the session down and the process can hang), and changing
 * the volume of audio that is already coming out of the speakers.
 */
export function createMpvIpcPlayer(detected: DetectedBackend, logger: Logger): AudioPlayer {
  const { executable } = detected;

  return {
    backend: {
      id: "mpv",
      label: "mpv (IPC: live pause + volume)",
      executable,
      supportsVolume: true,
      supportsHardPause: true,
      supportsLiveVolume: true,
    },

    play(file, options = {}): PlaybackHandle {
      const volume = clamp01(options.volume ?? 1);
      const socketPath = socketPathFor(++playCounter);

      let settle: (outcome: PlaybackOutcome) => void;
      const done = new Promise<PlaybackOutcome>((resolve) => {
        settle = resolve;
      });

      let settled = false;
      let stopRequested = false;
      let paused = false;
      let killTimer: NodeJS.Timeout | undefined;
      let stderr = "";
      let socket: Socket | null = null;
      /**
       * The control channel is only trusted once it has actually connected.
       * pause()/setVolume() must refuse (return false) until then: claiming a
       * freeze that never reaches mpv leaves audio playing while the scheduler
       * believes it is frozen -- and a replay would then overlap it.
       */
      let controlLive = false;

      const finish = (outcome: PlaybackOutcome) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        socket?.destroy();
        socket = null;
        if (!isWindows) void unlink(socketPath).catch(() => {});
        settle(outcome);
      };

      let child: ChildProcess;
      try {
        child = spawn(
          executable,
          [
            "--no-config",
            "--no-video",
            "--no-terminal",
            "--really-quiet",
            `--volume=${Math.round(volume * 100)}`,
            `--input-ipc-server=${socketPath}`,
            file,
          ],
          { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
        );
      } catch (error) {
        finish({
          status: "failed",
          error: new VoiceBoxError("playback_failed", "Could not start mpv", { cause: error }),
        });
        return inertHandle(done);
      }

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
        }
      });

      child.on("error", (error) => {
        finish({
          status: "failed",
          error: new VoiceBoxError("playback_failed", `mpv failed: ${error.message}`, {
            cause: error,
          }),
        });
      });

      child.on("close", (code, signal) => {
        if (stopRequested) {
          finish({ status: "stopped" });
          return;
        }
        if (code === 0) {
          finish({ status: "completed" });
          return;
        }
        const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        finish({
          status: "failed",
          error: new VoiceBoxError(
            "playback_failed",
            `mpv exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ""}`,
          ),
        });
      });

      const send = (command: unknown[]): boolean => {
        if (!controlLive || !socket) return false;
        socket.write(JSON.stringify({ command }) + "\n");
        return true;
      };

      // Poll for the socket: mpv creates it during startup, so the first
      // connect attempts routinely fail. Until it connects, the handle simply
      // reports "no control channel" and the scheduler uses boundary pause.
      const connectStartedAt = Date.now();
      const tryConnect = (): void => {
        if (settled) return;
        const attempt = createConnection(socketPath);
        attempt.on("connect", () => {
          if (settled) {
            attempt.destroy();
            return;
          }
          socket = attempt;
          controlLive = true;
        });
        attempt.on("close", () => {
          if (socket === attempt) {
            socket = null;
            controlLive = false;
          }
        });
        attempt.on("error", () => {
          attempt.destroy();
          if (settled || socket === attempt) return;
          if (Date.now() - connectStartedAt > CONNECT_DEADLINE_MS) {
            logger.debug("mpv IPC socket never came up; control channel disabled");
            return;
          }
          setTimeout(tryConnect, CONNECT_RETRY_MS).unref();
        });
        // The socket receives mpv's event stream; drain and ignore it.
        attempt.on("data", () => {});
      };
      tryConnect();

      return {
        done,
        get paused() {
          return paused;
        },

        stop() {
          if (settled || stopRequested) return;
          stopRequested = true;
          const pid = child.pid;
          if (pid === undefined) {
            finish({ status: "stopped" });
            return;
          }
          // mpv exits cleanly on SIGTERM; no IPC handshake needed.
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, KILL_GRACE_MS);
          killTimer.unref();
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        },

        pause() {
          if (settled || stopRequested || paused) return false;
          if (!send(["set_property", "pause", true])) return false;
          paused = true;
          return true;
        },

        resume() {
          if (settled || !paused) return false;
          paused = false;
          send(["set_property", "pause", false]);
          return true;
        },

        setVolume(next: number) {
          if (settled || stopRequested) return false;
          return send(["set_property", "volume", Math.round(clamp01(next) * 100)]);
        },
      };
    },
  };
}

/** Handle for a playback that failed before the process existed. */
function inertHandle(done: Promise<PlaybackOutcome>): PlaybackHandle {
  return {
    done,
    paused: false,
    stop() {},
    pause() {
      return false;
    },
    resume() {
      return false;
    },
  };
}
