import { VoiceBoxError } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import { findBackendSpec } from "./backends.js";
import { createCommandPlayer } from "./commandPlayer.js";
import { detectBackends, resolveExecutable, type DetectionReport } from "./detect.js";
import { createNullPlayer } from "./nullPlayer.js";
import type { AudioPlayer, AudioBackendSpec } from "./types.js";

export * from "./types.js";
export { detectBackends, resolveExecutable, type DetectionReport, type DetectedBackend } from "./detect.js";
export { AUDIO_BACKENDS, backendsForPlatform } from "./backends.js";

export interface ResolvePlayerOptions {
  /** Backend id from config, or "auto" to take the first available. */
  preferred?: string;
  /** Escape hatch: a custom command line using {file} and {volume} placeholders. */
  customCommand?: string;
  logger: Logger;
}

export interface ResolvedPlayer {
  player: AudioPlayer;
  report: DetectionReport;
}

/**
 * Pick the audio backend for this machine.
 *
 * Never throws: a machine with no player still gets a working daemon, just a
 * silent one. An explicitly configured backend that is missing is a real
 * misconfiguration though, so that case is logged loudly before falling back.
 */
export async function resolveAudioPlayer(options: ResolvePlayerOptions): Promise<ResolvedPlayer> {
  const { logger, preferred, customCommand } = options;
  const report = await detectBackends();

  if (customCommand?.trim()) {
    const custom = await buildCustomBackend(customCommand.trim());
    if (custom) {
      logger.info("using custom audio command", { command: custom.spec.command });
      return { player: createCommandPlayer(custom, logger), report };
    }
    logger.warn("custom audio command is not executable -- falling back to detection", {
      customCommand,
    });
  }

  if (preferred && preferred !== "auto") {
    const match = report.available.find((entry) => entry.spec.id === preferred);
    if (match) {
      return { player: createCommandPlayer(match, logger), report };
    }
    const known = findBackendSpec(preferred);
    logger.warn("configured audio backend is unavailable -- falling back", {
      preferred,
      hint: known?.installHint,
    });
  }

  const first = report.available[0];
  if (first) {
    logger.info("audio backend selected", { backend: first.spec.id, executable: first.executable });
    return { player: createCommandPlayer(first, logger), report };
  }

  const reason = describeMissingBackends(report);
  logger.error("no audio backend found", { platform: report.platform });
  return { player: createNullPlayer(logger, reason), report };
}

/** Human-readable explanation plus install guidance, used in errors and the UI. */
export function describeMissingBackends(report: DetectionReport): string {
  const hints = report.missing
    .map((entry) => entry.installHint)
    .filter((hint): hint is string => Boolean(hint));
  const unique = [...new Set(hints)];
  const suffix = unique.length ? ` Try one of: ${unique.join(" | ")}` : "";
  return `No supported audio player found on PATH (${report.platform}).${suffix}`;
}

export function noAudioBackendError(report: DetectionReport): VoiceBoxError {
  return new VoiceBoxError("no_audio_backend", describeMissingBackends(report), {
    hint: "Run `voice-box doctor` to see which players were probed.",
  });
}

/**
 * Turn a user-supplied command line into a backend spec.
 * Split on whitespace only -- no shell is involved, so a quoted path with
 * spaces is not supported and that limitation is documented rather than
 * papered over with `shell: true`, which would be a command-injection vector.
 */
async function buildCustomBackend(
  commandLine: string,
): Promise<{ spec: AudioBackendSpec; executable: string } | null> {
  const parts = commandLine.split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (!command) return null;

  const executable = await resolveExecutable(command);
  if (!executable) return null;

  const template = parts.slice(1);
  const spec: AudioBackendSpec = {
    id: "custom",
    label: `custom (${command})`,
    platforms: [process.platform],
    command,
    supportsVolume: template.some((part) => part.includes("{volume}")),
    buildArgs: (file, volume) =>
      template.map((part) =>
        part.replaceAll("{file}", file).replaceAll("{volume}", volume.toFixed(3)),
      ),
  };

  return { spec, executable };
}
