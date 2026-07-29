import OpenAI, { APIError } from "openai";

import { VoiceBoxError } from "../../shared/errors.js";
import type {
  ProviderLimits,
  SynthesisRequest,
  SynthesisResult,
  VoiceDescriptor,
  VoiceSelection,
} from "../../shared/types.js";
import type { ApiKeyResolver, KeyVerification, TtsProvider, VoiceValidation } from "./types.js";

/**
 * Voices validated against the standard TTS API.
 *
 * `ballad` and `verse` are deliberately absent: they are Realtime API
 * exclusives and return a 400 from tts-1/tts-1-hd. This list was corrected
 * once already (commit 002a291) after shipping the broken set -- do not add
 * voices here without confirming them against the TTS endpoint specifically.
 */
const OPENAI_VOICES: readonly { voiceId: string; label: string; description: string }[] = [
  { voiceId: "alloy", label: "Alloy", description: "Neutral and balanced" },
  { voiceId: "ash", label: "Ash", description: "Warm and measured" },
  { voiceId: "coral", label: "Coral", description: "Bright and friendly" },
  { voiceId: "echo", label: "Echo", description: "Calm and even" },
  { voiceId: "fable", label: "Fable", description: "Expressive, storytelling" },
  { voiceId: "nova", label: "Nova", description: "Warm and natural" },
  { voiceId: "onyx", label: "Onyx", description: "Deep and authoritative" },
  { voiceId: "sage", label: "Sage", description: "Soft and thoughtful" },
  { voiceId: "shimmer", label: "Shimmer", description: "Light and upbeat" },
];

export const OPENAI_MODELS = ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"] as const;

const LIMITS: ProviderLimits = { maxChars: 4096, maxConcurrent: 4 };

export function createOpenAiProvider(getApiKey: ApiKeyResolver): TtsProvider {
  let cached: { key: string; client: OpenAI } | undefined;

  const client = (): OpenAI => {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new VoiceBoxError("not_configured", "No OpenAI API key configured.", {
        hint: "Add one in the Voice Box control panel, or set OPENAI_API_KEY.",
      });
    }
    if (cached?.key !== apiKey) {
      cached = { key: apiKey, client: new OpenAI({ apiKey }) };
    }
    return cached.client;
  };

  return {
    id: "openai",
    displayName: "OpenAI",
    limits: LIMITS,
    envVar: "OPENAI_API_KEY",

    isConfigured: () => Boolean(getApiKey()),

    defaultVoice: (): VoiceSelection => ({
      providerId: "openai",
      voiceId: "nova",
      modelId: "tts-1",
    }),

    async listVoices(): Promise<VoiceDescriptor[]> {
      // Static: OpenAI has no voice-listing endpoint.
      return OPENAI_VOICES.map((voice) => ({
        providerId: "openai" as const,
        voiceId: voice.voiceId,
        label: voice.label,
        description: voice.description,
      }));
    },

    validate(selection: VoiceSelection): VoiceValidation {
      if (!selection.voiceId.trim()) return { ok: false, reason: "Voice id must not be empty." };
      if (selection.speed !== undefined && (selection.speed < 0.25 || selection.speed > 4)) {
        return { ok: false, reason: "OpenAI speed must be between 0.25 and 4.0." };
      }
      // Unknown voice ids pass through on purpose: OpenAI adds voices faster
      // than this package ships, and the API gives a clear error if wrong.
      return { ok: true };
    },

    async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
      const { text, voice } = request;
      if (text.length > LIMITS.maxChars) {
        throw new VoiceBoxError(
          "text_too_long",
          `Text is ${text.length} characters; OpenAI accepts at most ${LIMITS.maxChars}.`,
        );
      }

      try {
        const response = await client().audio.speech.create(
          {
            model: voice.modelId ?? "tts-1",
            voice: voice.voiceId,
            input: text,
            response_format: "mp3",
            ...(voice.speed !== undefined ? { speed: voice.speed } : {}),
          },
          signal ? { signal } : undefined,
        );

        return {
          format: "mp3",
          mime: "audio/mpeg",
          bytes: Buffer.from(await response.arrayBuffer()),
          charsBilled: text.length,
          voice,
        };
      } catch (error) {
        throw mapOpenAiError(error);
      }
    },

    async verifyKey(apiKey: string): Promise<KeyVerification> {
      try {
        // Cheapest authenticated call available.
        await new OpenAI({ apiKey: apiKey.trim(), maxRetries: 0 }).models.list();
        return { ok: true };
      } catch (error) {
        const mapped = mapOpenAiError(error);
        return { ok: false, detail: mapped.message };
      }
    },
  };
}

function mapOpenAiError(error: unknown): VoiceBoxError {
  if (error instanceof VoiceBoxError) return error;

  if (error instanceof APIError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new VoiceBoxError("provider_auth", "OpenAI rejected the API key.", {
        hint: "Check the key in the Voice Box control panel.",
        cause: error,
      });
    }
    if (status === 429) {
      return new VoiceBoxError("provider_rate_limit", "OpenAI rate limit reached.", {
        retryable: true,
        cause: error,
      });
    }
    if (status !== undefined && status >= 500) {
      return new VoiceBoxError("provider_error", `OpenAI server error (${status}).`, {
        retryable: true,
        cause: error,
      });
    }
    return new VoiceBoxError("provider_error", `OpenAI error: ${error.message}`, { cause: error });
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new VoiceBoxError("provider_error", "Synthesis was cancelled.", { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new VoiceBoxError("provider_error", `OpenAI request failed: ${message}`, {
    retryable: true,
    cause: error,
  });
}
