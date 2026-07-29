import type {
  ProviderId,
  ProviderLimits,
  SynthesisRequest,
  SynthesisResult,
  VoiceDescriptor,
  VoiceSelection,
} from "../../shared/types.js";

export interface KeyVerification {
  ok: boolean;
  /** Human-readable reason when ok is false. Never contains the key. */
  detail?: string;
}

export type VoiceValidation = { ok: true } | { ok: false; reason: string };

export interface TtsProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly limits: ProviderLimits;
  /** Which env var configures this provider from a shell. */
  readonly envVar: string;

  /** True when a key is available from either the environment or secrets.json. */
  isConfigured(): boolean;

  defaultVoice(): VoiceSelection;

  /** Voices for the control panel's picker. May hit the network (cached). */
  listVoices(): Promise<VoiceDescriptor[]>;

  validate(selection: VoiceSelection): VoiceValidation;

  synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<SynthesisResult>;

  /** Cheap auth probe, used before persisting a key entered in the UI. */
  verifyKey(apiKey: string): Promise<KeyVerification>;
}

/** Key lookup is a callback so a key set in the UI takes effect without a restart. */
export type ApiKeyResolver = () => string | undefined;
