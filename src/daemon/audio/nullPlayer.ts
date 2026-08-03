import type { Logger } from "../../shared/log.js";
import type { AudioPlayer, PlaybackHandle } from "./types.js";

/**
 * Last-resort backend for machines with no usable player.
 *
 * It reports `degraded` rather than failing: a missing speaker should never
 * crash the daemon or block an agent's work. The caller surfaces a warning so
 * the agent can tell the user, and the control panel shows a banner.
 */
export function createNullPlayer(logger: Logger, reason: string): AudioPlayer {
  return {
    backend: {
      id: "none",
      label: "No audio backend",
      executable: null,
      supportsVolume: false,
      supportsHardPause: false,
      supportsLiveVolume: false,
    },

    play(file): PlaybackHandle {
      logger.warn("no audio backend -- utterance not played", { file, reason });
      return {
        done: Promise.resolve({ status: "degraded" as const, reason }),
        paused: false,
        stop() {},
        pause() {
          return false;
        },
        resume() {
          return false;
        },
      };
    },
  };
}
