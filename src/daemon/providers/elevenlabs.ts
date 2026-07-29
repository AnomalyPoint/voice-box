import { VoiceBoxError } from "../../shared/errors.js";
import type {
  ProviderLimits,
  SynthesisRequest,
  SynthesisResult,
  VoiceDescriptor,
  VoiceSelection,
} from "../../shared/types.js";
import type { ApiKeyResolver, KeyVerification, TtsProvider, VoiceValidation } from "./types.js";

const API_BASE = "https://api.elevenlabs.io";

/** Matches the 24kHz mono-ish profile used elsewhere while staying widely supported. */
const OUTPUT_FORMAT = "mp3_44100_128";

/** Balance of latency and quality; the model is overridable per voice. */
export const DEFAULT_ELEVENLABS_MODEL = "eleven_turbo_v2_5";

/**
 * Conservative cap. Model limits vary (10k for multilingual_v2, far more for
 * flash/turbo), so we guard well below the lowest rather than reject valid
 * requests based on a model table that will drift.
 */
const LIMITS: ProviderLimits = { maxChars: 5000, maxConcurrent: 3 };

const VOICE_CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

interface ElevenLabsVoice {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string;
  preview_url?: string;
}

export function createElevenLabsProvider(getApiKey: ApiKeyResolver): TtsProvider {
  let voiceCache: { at: number; voices: VoiceDescriptor[] } | undefined;

  const requireKey = (): string => {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new VoiceBoxError("not_configured", "No ElevenLabs API key configured.", {
        hint: "Add one in the Voice Box control panel, or set ELEVENLABS_API_KEY.",
      });
    }
    return apiKey;
  };

  const request = async (
    path: string,
    init: RequestInit & { apiKey?: string } = {},
    signal?: AbortSignal,
  ): Promise<Response> => {
    const { apiKey, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await fetch(`${API_BASE}${path}`, {
        ...rest,
        signal: controller.signal,
        headers: {
          "xi-api-key": apiKey ?? requireKey(),
          ...(rest.headers ?? {}),
        },
      });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new VoiceBoxError("provider_error", "ElevenLabs request timed out.", {
          retryable: true,
          cause: error,
        });
      }
      throw new VoiceBoxError("provider_error", "Could not reach ElevenLabs.", {
        retryable: true,
        hint: "Check your network connection.",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    id: "elevenlabs",
    displayName: "ElevenLabs",
    limits: LIMITS,
    envVar: "ELEVENLABS_API_KEY",

    isConfigured: () => Boolean(getApiKey()),

    defaultVoice: (): VoiceSelection => ({
      providerId: "elevenlabs",
      // Rachel: present on every account, so a fresh install has something that works.
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      modelId: DEFAULT_ELEVENLABS_MODEL,
    }),

    async listVoices(): Promise<VoiceDescriptor[]> {
      if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_TTL_MS) {
        return voiceCache.voices;
      }

      const response = await request("/v1/voices", { method: "GET" });
      if (!response.ok) throw await mapErrorResponse(response, "list voices");

      const payload = (await response.json()) as { voices?: ElevenLabsVoice[] };
      const voices: VoiceDescriptor[] = (payload.voices ?? []).map((voice) => ({
        providerId: "elevenlabs" as const,
        voiceId: voice.voice_id,
        label: voice.name ?? voice.voice_id,
        ...(voice.description ? { description: voice.description } : {}),
        ...(voice.preview_url ? { previewUrl: voice.preview_url } : {}),
        ...(voice.category ? { category: voice.category } : {}),
      }));

      voiceCache = { at: Date.now(), voices };
      return voices;
    },

    validate(selection: VoiceSelection): VoiceValidation {
      if (!selection.voiceId.trim()) {
        return { ok: false, reason: "ElevenLabs needs a voice id -- pick one in the control panel." };
      }
      return { ok: true };
    },

    async synthesize(req: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult> {
      const { text, voice } = req;
      if (text.length > LIMITS.maxChars) {
        throw new VoiceBoxError(
          "text_too_long",
          `Text is ${text.length} characters; Voice Box caps ElevenLabs requests at ${LIMITS.maxChars}.`,
        );
      }

      const body: Record<string, unknown> = {
        text,
        model_id: voice.modelId ?? DEFAULT_ELEVENLABS_MODEL,
      };
      if (voice.options && Object.keys(voice.options).length > 0) {
        body["voice_settings"] = voice.options;
      }
      if (voice.speed !== undefined) {
        body["voice_settings"] = {
          ...(body["voice_settings"] as Record<string, unknown> | undefined),
          speed: voice.speed,
        };
      }

      const path = `/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}?output_format=${OUTPUT_FORMAT}`;
      const response = await request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify(body),
        },
        signal,
      );

      if (!response.ok) throw await mapErrorResponse(response, "synthesize speech");

      return {
        format: "mp3",
        mime: "audio/mpeg",
        bytes: Buffer.from(await response.arrayBuffer()),
        charsBilled: text.length,
        voice,
      };
    },

    async verifyKey(apiKey: string): Promise<KeyVerification> {
      try {
        const response = await request("/v1/user", { method: "GET", apiKey: apiKey.trim() });
        if (response.ok) return { ok: true };
        const mapped = await mapErrorResponse(response, "verify key");
        return { ok: false, detail: mapped.message };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * Map an error response to a typed error, surfacing the provider's own detail
 * rather than swallowing it -- a 422 usually says exactly what was wrong.
 */
async function mapErrorResponse(response: Response, action: string): Promise<VoiceBoxError> {
  const detail = await readErrorDetail(response);
  const suffix = detail ? `: ${detail}` : "";

  if (response.status === 401 || response.status === 403) {
    return new VoiceBoxError("provider_auth", `ElevenLabs rejected the API key${suffix}`, {
      hint: "Check the key in the Voice Box control panel.",
    });
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return new VoiceBoxError("provider_rate_limit", `ElevenLabs rate limit reached${suffix}`, {
      retryable: true,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    });
  }
  if (response.status === 422) {
    return new VoiceBoxError("invalid_input", `ElevenLabs could not ${action}${suffix}`, {
      hint: "The voice id or model id may be wrong for this account.",
    });
  }
  if (response.status >= 500) {
    return new VoiceBoxError("provider_error", `ElevenLabs server error (${response.status})${suffix}`, {
      retryable: true,
    });
  }
  return new VoiceBoxError(
    "provider_error",
    `ElevenLabs could not ${action} (${response.status})${suffix}`,
  );
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      const detail = parsed.detail;
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object" && "message" in detail) {
        return String((detail as { message: unknown }).message);
      }
    } catch {
      /* not JSON -- fall through to the raw body */
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}
