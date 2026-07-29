import type { VoiceBoxError } from "../../shared/errors.js";

export type PlaybackOutcome =
  | { status: "completed" }
  | { status: "stopped" }
  /** No usable player on this machine: the text is logged, nothing is audible. */
  | { status: "degraded"; reason: string }
  | { status: "failed"; error: VoiceBoxError };

export interface PlaybackHandle {
  /** Resolves when playback ends -- naturally, by stop(), or on failure. Never rejects. */
  readonly done: Promise<PlaybackOutcome>;
  /** Terminate playback now. Idempotent. */
  stop(): void;
  /**
   * Suspend the player process mid-utterance (POSIX SIGSTOP).
   * Returns false where unsupported (Windows) -- callers fall back to
   * pausing at the utterance boundary instead.
   */
  pause(): boolean;
  resume(): boolean;
  readonly paused: boolean;
}

/** A concrete way to get an MP3 file out of the speakers on this machine. */
export interface AudioBackendSpec {
  id: string;
  label: string;
  platforms: readonly NodeJS.Platform[];
  /** Executable to look up on PATH. */
  command: string;
  /** argv for playing `file`; `volume` is 0..1 and converted per-player. */
  buildArgs(file: string, volume: number): string[];
  supportsVolume: boolean;
  /** Shown by `voice-box doctor` when this backend is missing. */
  installHint?: string;
}

export interface AudioBackendInfo {
  id: string;
  label: string;
  /** Absolute path of the resolved executable, or null for the null backend. */
  executable: string | null;
  supportsVolume: boolean;
  supportsHardPause: boolean;
}

export interface AudioPlayer {
  readonly backend: AudioBackendInfo;
  play(file: string, options?: { volume?: number }): PlaybackHandle;
}
