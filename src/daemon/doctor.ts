import { stat } from "node:fs/promises";

import { assetPath } from "../shared/assets.js";
import { createLogger } from "../shared/log.js";
import { getPaths, ensureHome } from "../shared/paths.js";
import { detectBackends, resolveAudioPlayer } from "./audio/index.js";
import { ConfigStore } from "./config/store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { PKG_VERSION } from "../version.js";

const check = (ok: boolean) => (ok ? "ok  " : "FAIL");
const isWindows = process.platform === "win32";

export interface DoctorOptions {
  /** Also play a short tone to prove audio actually reaches the speakers. */
  selftest?: boolean;
}

/**
 * Diagnose an installation. Exits non-zero when something is actually broken,
 * so it is usable as a CI gate as well as a human troubleshooting command.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const logger = createLogger({ scope: "doctor", level: "warn" });
  const paths = getPaths();
  let failures = 0;

  const line = (label: string, ok: boolean, detail = "") => {
    if (!ok) failures++;
    console.log(`  [${check(ok)}] ${label}${detail ? ` -- ${detail}` : ""}`);
  };

  console.log(`\nVoice Box ${PKG_VERSION}`);
  console.log(`  node ${process.version} on ${process.platform} (${process.arch})\n`);

  // --- Storage -------------------------------------------------------------
  console.log("Storage");
  await ensureHome(paths);
  line("home directory", true, paths.home);
  if (!isWindows) {
    try {
      const info = await stat(paths.home);
      const mode = info.mode & 0o777;
      line("home permissions are 0700", mode === 0o700, `found 0${mode.toString(8)}`);
    } catch (error) {
      line("home permissions", false, String(error));
    }
  }

  // --- Providers -----------------------------------------------------------
  console.log("\nProviders");
  const store = await ConfigStore.load(paths);
  const registry = ProviderRegistry.create(store);
  for (const status of store.describeSecrets()) {
    const provider = registry.require(status.providerId);
    const detail = status.configured
      ? `${status.hint} (from ${status.source})`
      : `not configured -- set ${provider.envVar} or use the control panel`;
    // Not having a key is a normal state, not a failure.
    console.log(`  [${status.configured ? "ok  " : "--  "}] ${provider.displayName} -- ${detail}`);
  }
  const anyProvider = registry.hasAnyConfigured();
  if (!anyProvider) {
    console.log("\n  No provider configured: speaking will return a setup error.");
  }

  // --- Audio ---------------------------------------------------------------
  console.log("\nAudio");
  const report = await detectBackends();
  for (const entry of report.available) {
    console.log(`  [ok  ] ${entry.spec.label} -- ${entry.executable}`);
  }
  for (const entry of report.missing) {
    console.log(`  [--  ] ${entry.label} -- not found${entry.installHint ? ` (${entry.installHint})` : ""}`);
  }
  line("at least one audio player is available", report.available.length > 0);

  const { player } = await resolveAudioPlayer({
    logger,
    preferred: store.config.audio.backend,
    ...(store.config.audio.customCommand !== undefined
      ? { customCommand: store.config.audio.customCommand }
      : {}),
  });
  if (report.available.length > 0) {
    console.log(`  selected: ${player.backend.label}`);
  }

  // --- Playback self-test --------------------------------------------------
  if (options.selftest) {
    console.log("\nSelf-test");
    const file = assetPath("selftest.mp3");
    const startedAt = Date.now();
    const outcome = await player.play(file, { volume: store.config.audio.volume }).done;
    const elapsed = Date.now() - startedAt;
    line(
      "played a short tone",
      outcome.status === "completed",
      outcome.status === "completed"
        ? `${elapsed}ms`
        : outcome.status === "failed"
          ? outcome.error.message
          : outcome.status,
    );
  }

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  return failures === 0 ? 0 : 1;
}
