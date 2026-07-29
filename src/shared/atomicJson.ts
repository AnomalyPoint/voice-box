import { readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ZodTypeAny, output as ZodOutput } from "zod";

import { VoiceBoxError } from "./errors.js";
import { SECRET_FILE_MODE } from "./paths.js";

const isWindows = process.platform === "win32";

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export interface ReadJsonOptions {
  /**
   * Treat unparseable or schema-invalid content as absent instead of throwing.
   * Correct for runtime state we can regenerate (daemon.json); wrong for user
   * config, where silently discarding settings would be worse than an error.
   */
  tolerant?: boolean;
}

// Inferred from the schema's *output* type: `.default()` makes a schema's input
// and output differ, and the parsed result is always the output shape.
export async function readJsonFile<S extends ZodTypeAny>(
  filePath: string,
  schema: S,
  options: ReadJsonOptions = {},
): Promise<ZodOutput<S> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new VoiceBoxError("config_invalid", `Could not read ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (options.tolerant) return null;
    throw new VoiceBoxError("config_invalid", `${basename(filePath)} is not valid JSON`, {
      hint: `Fix or delete ${filePath} and try again.`,
      cause: error,
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    if (options.tolerant) return null;
    const summary = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new VoiceBoxError("config_invalid", `${basename(filePath)} failed validation -- ${summary}`, {
      hint: `Fix or delete ${filePath} and try again.`,
    });
  }

  return result.data;
}

/**
 * Write JSON via temp file + rename so a crash mid-write can never truncate the
 * live file, and so readers never observe a partial document.
 *
 * The mode is applied with an explicit chmod because the mode passed to
 * writeFile is masked by the process umask -- without this, a umask of 0022
 * silently yields a world-readable secrets file.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  mode: number = SECRET_FILE_MODE,
): Promise<void> {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  try {
    await writeFile(tmpPath, payload, { mode, encoding: "utf8" });
    if (!isWindows) await chmod(tmpPath, mode);
    // rename is atomic within a filesystem, and replaces the destination on
    // both POSIX and Windows.
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw new VoiceBoxError("config_invalid", `Could not write ${filePath}`, {
      hint: "Check that the directory exists and is writable.",
      cause: error,
    });
  }
}
