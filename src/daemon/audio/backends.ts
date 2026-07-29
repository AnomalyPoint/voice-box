import { assetPath } from "../../shared/assets.js";
import type { AudioBackendSpec } from "./types.js";

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * Candidate players, in preference order per platform.
 *
 * Every backend here decodes MP3 natively, which is why Voice Box no longer
 * needs ffmpeg or a native decoding addon: both TTS providers already return
 * MP3, so there is nothing to transcode.
 *
 * Deliberately absent: `aplay` and `paplay`. They play WAV/raw only -- handing
 * them an MP3 produces loud static rather than a clean failure, which is worse
 * than not having a backend at all.
 *
 * Ordering policy: prefer whatever ships with the OS, and accept the latency.
 * A seamless install matters more here than a few hundred milliseconds before
 * speech starts, since these are notifications rather than conversation.
 *
 * Measured startup overhead on macOS (arm64, 300ms clip, mean of 3):
 * afplay ~677ms, ffplay ~326ms, mpg123 ~284ms. afplay still goes first because
 * it is present on every Mac and follows system audio routing; the faster
 * players only exist if the user already installed them. Windows likewise
 * prefers built-in PowerShell. Linux has no guaranteed MP3 CLI player, so it
 * falls back to whichever of the common ones is present.
 *
 * Anyone who wants the lower latency can pin `audio.backend` in config.json.
 */
export const AUDIO_BACKENDS: readonly AudioBackendSpec[] = [
  {
    id: "afplay",
    label: "afplay (macOS CoreAudio)",
    platforms: ["darwin"],
    command: "afplay",
    supportsVolume: true,
    buildArgs: (file, volume) => ["-v", clamp01(volume).toFixed(3), file],
  },
  {
    id: "ffplay",
    label: "ffplay (FFmpeg)",
    platforms: ["darwin", "linux", "freebsd", "win32"],
    command: "ffplay",
    supportsVolume: true,
    installHint: "Install FFmpeg: brew install ffmpeg | apt install ffmpeg",
    buildArgs: (file, volume) => [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "-volume",
      String(Math.round(clamp01(volume) * 100)),
      file,
    ],
  },
  {
    id: "mpg123",
    label: "mpg123",
    platforms: ["linux", "darwin", "freebsd"],
    command: "mpg123",
    supportsVolume: true,
    installHint: "Install mpg123: apt install mpg123 | brew install mpg123",
    // -f takes a linear scale factor where 32768 is unity gain.
    buildArgs: (file, volume) => ["-q", "-f", String(Math.round(clamp01(volume) * 32768)), file],
  },
  {
    id: "mpv",
    label: "mpv",
    platforms: ["darwin", "linux", "freebsd", "win32"],
    command: "mpv",
    supportsVolume: true,
    installHint: "Install mpv: brew install mpv | apt install mpv",
    buildArgs: (file, volume) => [
      "--no-video",
      "--really-quiet",
      `--volume=${Math.round(clamp01(volume) * 100)}`,
      file,
    ],
  },
  {
    id: "cvlc",
    label: "VLC (cvlc)",
    platforms: ["darwin", "linux", "freebsd"],
    command: "cvlc",
    supportsVolume: false,
    installHint: "Install VLC: apt install vlc | brew install --cask vlc",
    buildArgs: (file) => ["--intf", "dummy", "--play-and-exit", "--quiet", file],
  },
  {
    id: "pwsh",
    label: "PowerShell 7 (MediaPlayer)",
    platforms: ["win32"],
    command: "pwsh",
    supportsVolume: true,
    buildArgs: (file, volume) => buildPowerShellArgs(file, volume),
  },
  {
    id: "powershell",
    label: "Windows PowerShell (MediaPlayer)",
    platforms: ["win32"],
    command: "powershell",
    supportsVolume: true,
    buildArgs: (file, volume) => buildPowerShellArgs(file, volume),
  },
];

/**
 * Invoke a shipped script file rather than an inline -Command string: quoting a
 * one-liner through cmd + PowerShell is a reliable source of breakage, and a
 * file is reviewable in the public repo.
 */
function buildPowerShellArgs(file: string, volume: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    assetPath("win-play.ps1"),
    "-Path",
    file,
    "-Volume",
    clamp01(volume).toFixed(3),
  ];
}

export function backendsForPlatform(platform: NodeJS.Platform = process.platform): AudioBackendSpec[] {
  return AUDIO_BACKENDS.filter((backend) => backend.platforms.includes(platform));
}

export function findBackendSpec(id: string): AudioBackendSpec | undefined {
  return AUDIO_BACKENDS.find((backend) => backend.id === id);
}
