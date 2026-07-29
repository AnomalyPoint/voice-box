import { createHash } from "node:crypto";
import { writeFile, readdir, stat, unlink, rename } from "node:fs/promises";
import { join } from "node:path";

import type { VoiceSelection } from "../../shared/types.js";
import type { Logger } from "../../shared/log.js";

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Content-addressed store of synthesized audio.
 *
 * Every backend needs a file on disk anyway (afplay and Windows MediaPlayer
 * cannot read stdin), so caching by content is nearly free and makes repeated
 * phrases -- "Done.", "Tests passed." -- instant and free of API charges.
 */
export class AudioCache {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  /** Stable key over the text and every field that changes the audio. */
  keyFor(text: string, voice: VoiceSelection): string {
    const shape = JSON.stringify([
      voice.providerId,
      voice.voiceId,
      voice.modelId ?? null,
      voice.speed ?? null,
      voice.options ?? null,
      text,
    ]);
    return createHash("sha256").update(shape).digest("hex");
  }

  pathFor(key: string): string {
    return join(this.dir, `${key}.mp3`);
  }

  async has(key: string): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  /** Write via temp + rename so a concurrent reader never sees a partial file. */
  async write(key: string, bytes: Buffer): Promise<string> {
    const target = this.pathFor(key);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    return target;
  }

  /**
   * Drop entries that are too old or push the directory over its size budget.
   * Cheap enough to run at startup; without it the cache grows without bound.
   */
  async prune(
    maxBytes = DEFAULT_MAX_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  ): Promise<{ removed: number; bytesFreed: number }> {
    let removed = 0;
    let bytesFreed = 0;

    try {
      const names = (await readdir(this.dir)).filter((name) => name.endsWith(".mp3"));
      const entries: { path: string; size: number; mtimeMs: number }[] = [];

      for (const name of names) {
        const path = join(this.dir, name);
        try {
          const info = await stat(path);
          entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          /* vanished under us -- fine */
        }
      }

      const now = Date.now();
      const survivors: typeof entries = [];
      for (const entry of entries) {
        if (now - entry.mtimeMs > maxAgeMs) {
          await unlink(entry.path).catch(() => {});
          removed++;
          bytesFreed += entry.size;
        } else {
          survivors.push(entry);
        }
      }

      // Oldest-first eviction until the directory fits the budget.
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of survivors) {
        if (total <= maxBytes) break;
        await unlink(entry.path).catch(() => {});
        total -= entry.size;
        removed++;
        bytesFreed += entry.size;
      }
    } catch (error) {
      this.logger.debug("cache prune skipped", { error });
    }

    if (removed > 0) this.logger.debug("cache pruned", { removed, bytesFreed });
    return { removed, bytesFreed };
  }
}
