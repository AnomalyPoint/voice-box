import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";

import type { Logger } from "../../shared/log.js";
import { SECRET_FILE_MODE } from "../../shared/paths.js";
import type { UtteranceStatus, VoiceSelection } from "../../shared/types.js";

/** Rotate once the log passes this, keeping one previous generation. */
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 200;

export interface HistoryEntry {
  id: string;
  at: string;
  profileId: string;
  agentLabel: string;
  text: string;
  voice: string;
  status: UtteranceStatus;
  /** Cache key, when the audio is still replayable. */
  audioKey?: string;
  detail?: string;
}

/**
 * Append-only record of what was said.
 *
 * Written at 0600 like everything else in ~/.voice-box: utterance text is the
 * user's working context and occasionally sensitive, so it gets the same
 * treatment as the API keys rather than being left world-readable.
 */
export class HistoryLog {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  /** Serialised so concurrent appends cannot interleave a partial line. */
  append(entry: HistoryEntry): void {
    this.writing = this.writing
      .then(async () => {
        await this.rotateIfNeeded();
        await appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: SECRET_FILE_MODE });
      })
      .catch((error) => {
        this.logger.debug("history append failed", { error });
      });
  }

  async recent(limit = DEFAULT_LIMIT): Promise<HistoryEntry[]> {
    try {
      const text = await readFile(this.file, "utf8");
      const lines = text.trimEnd().split("\n").slice(-limit);
      const entries: HistoryEntry[] = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as HistoryEntry);
        } catch {
          // A torn final line after a crash is expected; skip it.
        }
      }
      return entries.reverse();
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    await writeFile(this.file, "", { mode: SECRET_FILE_MODE }).catch(() => {});
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.file);
      if (info.size < MAX_BYTES) return;
      await rename(this.file, `${this.file}.1`);
    } catch {
      /* no file yet, or rotation raced -- either way, carry on appending */
    }
  }
}

export function voiceLabel(voice: VoiceSelection): string {
  return `${voice.providerId}/${voice.voiceId}`;
}
