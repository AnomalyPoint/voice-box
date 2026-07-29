import type { VoiceBoxError } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import type { VoiceSelection } from "../../shared/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { TtsProvider } from "../providers/types.js";
import type { AudioCache } from "./cache.js";

export interface SynthesizedAudio {
  /** Absolute path to a playable MP3. */
  file: string;
  /** Content-addressed cache key, used to offer replay from the history log. */
  key: string;
  voice: VoiceSelection;
  /** True when the cache served this and no provider call was made. */
  cached: boolean;
  charsBilled: number;
  synthesisMs: number;
}

/** Turns text into a playable file, going through the cache first. */
export class Synthesizer {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly cache: AudioCache,
    private readonly logger: Logger,
  ) {}

  /** The provider that would handle this voice, for pre-flight checks. */
  providerFor(voice: VoiceSelection): TtsProvider {
    return this.registry.require(voice.providerId);
  }

  notConfiguredError(): VoiceBoxError {
    return this.registry.notConfiguredError();
  }

  async synthesize(
    text: string,
    voice: VoiceSelection,
    signal?: AbortSignal,
  ): Promise<SynthesizedAudio> {
    const key = this.cache.keyFor(text, voice);

    if (await this.cache.has(key)) {
      this.logger.debug("cache hit", { key: key.slice(0, 12), voice: voice.voiceId });
      return {
        file: this.cache.pathFor(key),
        key,
        voice,
        cached: true,
        charsBilled: 0,
        synthesisMs: 0,
      };
    }

    const startedAt = Date.now();
    const result = await this.registry.synthesize(text, voice, signal);
    const synthesisMs = Date.now() - startedAt;

    const file = await this.cache.write(key, result.bytes);
    this.logger.debug("synthesized", {
      provider: voice.providerId,
      voice: voice.voiceId,
      chars: result.charsBilled,
      synthesisMs,
    });

    return { file, key, voice, cached: false, charsBilled: result.charsBilled, synthesisMs };
  }
}
