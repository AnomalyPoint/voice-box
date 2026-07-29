import { spawn, execFile, type ChildProcess } from "node:child_process";

import { VoiceBoxError } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import type { DetectedBackend } from "./detect.js";
import type { AudioPlayer, PlaybackHandle, PlaybackOutcome } from "./types.js";

const isWindows = process.platform === "win32";

/** Grace period between asking a player to quit and killing it outright. */
const KILL_GRACE_MS = 500;
/** Bound stderr capture so a chatty player cannot balloon memory. */
const MAX_STDERR_BYTES = 8 * 1024;

export function createCommandPlayer(detected: DetectedBackend, logger: Logger): AudioPlayer {
  const { spec, executable } = detected;

  return {
    backend: {
      id: spec.id,
      label: spec.label,
      executable,
      supportsVolume: spec.supportsVolume,
      // SIGSTOP has no Windows equivalent; the scheduler falls back to
      // pausing at the utterance boundary there.
      supportsHardPause: !isWindows,
    },

    play(file, options = {}): PlaybackHandle {
      const volume = options.volume ?? 1;
      const args = spec.buildArgs(file, volume);

      let child: ChildProcess;
      let settle: (outcome: PlaybackOutcome) => void;
      const done = new Promise<PlaybackOutcome>((resolve) => {
        settle = resolve;
      });

      let settled = false;
      let stopRequested = false;
      let paused = false;
      let killTimer: NodeJS.Timeout | undefined;
      let stderr = "";

      const finish = (outcome: PlaybackOutcome) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        settle(outcome);
      };

      try {
        child = spawn(executable, args, {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        finish({
          status: "failed",
          error: new VoiceBoxError("playback_failed", `Could not start ${spec.label}`, {
            cause: error,
          }),
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
          error: new VoiceBoxError("playback_failed", `${spec.label} failed: ${error.message}`, {
            hint: spec.installHint,
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
            `${spec.label} exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ""}`,
            { hint: spec.installHint },
          ),
        });
      });

      const handle: PlaybackHandle = {
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

          // A SIGSTOPped process cannot act on SIGTERM -- resume it first or
          // the graceful path silently degrades into the SIGKILL fallback.
          if (paused && !isWindows) {
            try {
              child.kill("SIGCONT");
            } catch {
              /* already gone */
            }
            paused = false;
          }

          if (isWindows) {
            // child.kill() does not reap the PowerShell subtree.
            execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
            return;
          }

          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, KILL_GRACE_MS);
          killTimer.unref();
        },

        pause() {
          if (isWindows || settled || paused) return false;
          try {
            child.kill("SIGSTOP");
            paused = true;
            return true;
          } catch (error) {
            logger.debug("hard pause failed", { error });
            return false;
          }
        },

        resume() {
          if (isWindows || settled || !paused) return false;
          try {
            child.kill("SIGCONT");
            paused = false;
            return true;
          } catch (error) {
            logger.debug("resume failed", { error });
            return false;
          }
        },
      };

      return handle;
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
