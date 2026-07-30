import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, chmod, stat } from "node:fs/promises";

/**
 * All Voice Box state lives in one directory so it is trivially inspectable and
 * deletable. Windows uses the same location as POSIX rather than %APPDATA% --
 * consistency is worth more here than platform convention.
 */
export function voiceBoxHome(): string {
  const override = process.env["VOICE_BOX_HOME"]?.trim();
  return override ? resolve(override) : join(homedir(), ".voice-box");
}

export interface VoiceBoxPaths {
  home: string;
  /** Non-secret settings + agent profiles. Safe to paste into a bug report. */
  configFile: string;
  /** Provider API keys. Kept separate from config.json precisely so config.json is shareable. */
  secretsFile: string;
  /** Live daemon coordinates: pid, port, auth token. Removed on clean shutdown. */
  daemonFile: string;
  /** Persistent auth token, so an open panel tab survives daemon restarts. */
  tokenFile: string;
  /** Advisory mutex preventing a thundering herd of daemon spawns. */
  lockFile: string;
  historyFile: string;
  logsDir: string;
  logFile: string;
  /** Content-addressed synthesized audio. */
  cacheDir: string;
}

export function getPaths(home = voiceBoxHome()): VoiceBoxPaths {
  return {
    home,
    configFile: join(home, "config.json"),
    secretsFile: join(home, "secrets.json"),
    daemonFile: join(home, "daemon.json"),
    tokenFile: join(home, "token"),
    lockFile: join(home, "daemon.lock"),
    historyFile: join(home, "history.jsonl"),
    logsDir: join(home, "logs"),
    logFile: join(home, "logs", "daemon.log"),
    cacheDir: join(home, "cache"),
  };
}

/** File mode for anything that may contain a secret. */
export const SECRET_FILE_MODE = 0o600;
/** Directory mode for the Voice Box home. */
export const SECRET_DIR_MODE = 0o700;

const isWindows = process.platform === "win32";

/**
 * Create the home directory tree and repair its permissions if they have drifted.
 *
 * On Windows chmod is a no-op -- the directory inherits the user profile ACL.
 * We do not pretend otherwise; the README states this plainly.
 */
export async function ensureHome(paths: VoiceBoxPaths = getPaths()): Promise<VoiceBoxPaths> {
  await mkdir(paths.home, { recursive: true, mode: SECRET_DIR_MODE });
  await mkdir(paths.logsDir, { recursive: true, mode: SECRET_DIR_MODE });
  await mkdir(paths.cacheDir, { recursive: true, mode: SECRET_DIR_MODE });

  if (!isWindows) {
    for (const dir of [paths.home, paths.logsDir, paths.cacheDir]) {
      try {
        const info = await stat(dir);
        if ((info.mode & 0o777) !== SECRET_DIR_MODE) {
          await chmod(dir, SECRET_DIR_MODE);
        }
      } catch {
        // A permissions repair failure is not fatal; writes below will surface it.
      }
    }
  }

  return paths;
}
