import { VoiceBoxError } from "../../shared/errors.js";
import type { ProviderId, SynthesisResult, VoiceSelection } from "../../shared/types.js";
import { PROVIDER_IDS } from "../../shared/types.js";
import type { ConfigStore } from "../config/store.js";
import { createElevenLabsProvider } from "./elevenlabs.js";
import { createOpenAiProvider } from "./openai.js";
import type { TtsProvider } from "./types.js";

export class ProviderRegistry {
  private readonly providers: Map<ProviderId, TtsProvider>;

  private constructor(
    private readonly store: ConfigStore,
    providers: Map<ProviderId, TtsProvider>,
  ) {
    this.providers = providers;
  }

  static create(store: ConfigStore): ProviderRegistry {
    // Providers read their key through a callback, so a key added in the
    // control panel takes effect immediately without rebuilding the registry.
    const providers = new Map<ProviderId, TtsProvider>([
      ["openai", createOpenAiProvider(() => store.getApiKey("openai"))],
      ["elevenlabs", createElevenLabsProvider(() => store.getApiKey("elevenlabs"))],
    ]);
    return new ProviderRegistry(store, providers);
  }

  all(): TtsProvider[] {
    return PROVIDER_IDS.map((id) => this.require(id));
  }

  /** Providers with a usable API key, in declaration order. */
  configured(): TtsProvider[] {
    return this.all().filter((provider) => provider.isConfigured());
  }

  hasAnyConfigured(): boolean {
    return this.configured().length > 0;
  }

  require(providerId: ProviderId): TtsProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new VoiceBoxError("invalid_input", `Unknown TTS provider "${providerId}".`);
    }
    return provider;
  }

  /**
   * Decide which voice to actually use.
   *
   * Order is deliberately short -- profile voice, else the global default --
   * because agents cannot pass a voice per utterance. The one wrinkle: if the
   * chosen voice belongs to a provider with no key, fall back to a provider
   * that does have one rather than failing, so removing a key degrades to a
   * different voice instead of silence.
   */
  resolveVoice(preferred?: VoiceSelection): VoiceSelection {
    const configured = this.configured();
    if (configured.length === 0) {
      throw this.notConfiguredError();
    }

    const candidate = preferred ?? this.store.config.voice.default;
    const owner = this.providers.get(candidate.providerId);
    if (owner?.isConfigured()) {
      const validation = owner.validate(candidate);
      if (validation.ok) return candidate;
      throw new VoiceBoxError("invalid_input", validation.reason);
    }

    const fallback = configured[0];
    if (!fallback) throw this.notConfiguredError();
    return fallback.defaultVoice();
  }

  /** Consistent, actionable error for "nothing is set up yet". */
  notConfiguredError(): VoiceBoxError {
    const envVars = this.all()
      .map((provider) => provider.envVar)
      .join(" or ");
    return new VoiceBoxError("not_configured", "No text-to-speech provider is configured.", {
      hint: `Run \`voice-box\` to add an API key, or set ${envVars}.`,
    });
  }

  async synthesize(
    text: string,
    voice: VoiceSelection,
    signal?: AbortSignal,
  ): Promise<SynthesisResult> {
    return this.require(voice.providerId).synthesize({ text, voice }, signal);
  }
}
