import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { backendsForPlatform } from "./backends.js";
import type { AudioBackendSpec } from "./types.js";

export interface DetectedBackend {
  spec: AudioBackendSpec;
  executable: string;
}

export interface DetectionReport {
  platform: NodeJS.Platform;
  available: DetectedBackend[];
  missing: { id: string; label: string; installHint?: string }[];
}

const isWindows = process.platform === "win32";

function pathEntries(): string[] {
  const raw = process.env["PATH"] ?? process.env["Path"] ?? "";
  const entries = raw.split(delimiter).filter((entry) => entry.length > 0);

  // GUI-launched processes on macOS inherit a minimal PATH that omits Homebrew.
  // v1's bare spawn("ffmpeg") worked in a terminal and failed with ENOENT under
  // Claude Desktop for exactly this reason, so probe the usual locations too.
  if (process.platform === "darwin") {
    for (const extra of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
      if (!entries.includes(extra)) entries.push(extra);
    }
  }
  return entries;
}

function windowsExtensions(): string[] {
  const raw = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter(Boolean);
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  if (isWindows) return true; // X_OK is meaningless on Windows
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command against PATH without shelling out to `which`/`where`.
 * Avoids a subprocess per candidate and any shell-quoting surprises.
 */
export async function resolveExecutable(command: string): Promise<string | null> {
  if (isAbsolute(command)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  const extensions = isWindows ? ["", ...windowsExtensions()] : [""];
  for (const dir of pathEntries()) {
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Probe every candidate for this platform. Cheap enough to re-run on demand. */
export async function detectBackends(
  platform: NodeJS.Platform = process.platform,
): Promise<DetectionReport> {
  const specs = backendsForPlatform(platform);
  const available: DetectedBackend[] = [];
  const missing: DetectionReport["missing"] = [];

  const results = await Promise.all(
    specs.map(async (spec) => ({ spec, executable: await resolveExecutable(spec.command) })),
  );

  for (const { spec, executable } of results) {
    if (executable) {
      available.push({ spec, executable });
    } else {
      missing.push({
        id: spec.id,
        label: spec.label,
        ...(spec.installHint !== undefined ? { installHint: spec.installHint } : {}),
      });
    }
  }

  return { platform, available, missing };
}
