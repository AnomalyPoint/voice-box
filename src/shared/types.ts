/** Domain types shared by the MCP client, the daemon, and the web UI. */

export const PROVIDER_IDS = ["openai", "elevenlabs"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * A fully-qualified voice: which provider, which voice, which model.
 *
 * This is persistent per-agent state owned by the human via the control panel.
 * Agents deliberately cannot pass a voice per utterance -- that collapses voice
 * resolution to "agent profile, else global default" and removes a whole class
 * of "the agent overrode my choice" confusion.
 */
export interface VoiceSelection {
  providerId: ProviderId;
  /** "nova" for OpenAI; a 20-character voice id for ElevenLabs. */
  voiceId: string;
  modelId?: string;
  /** Playback rate where the provider supports it. 0.25-4.0 for OpenAI. */
  speed?: number;
  /** Provider-specific knobs, e.g. ElevenLabs stability / similarity_boost / style. */
  options?: Record<string, unknown>;
}

/** A voice offered by a provider, for the control panel's picker. */
export interface VoiceDescriptor {
  providerId: ProviderId;
  voiceId: string;
  label: string;
  description?: string;
  /** Provider-hosted sample, when one exists. */
  previewUrl?: string;
  category?: string;
}

export interface SynthesisRequest {
  text: string;
  voice: VoiceSelection;
}

export interface SynthesisResult {
  format: "mp3";
  mime: "audio/mpeg";
  bytes: Buffer;
  /** Characters billed by the provider, for cost visibility in the UI. */
  charsBilled: number;
  voice: VoiceSelection;
}

export interface ProviderLimits {
  maxChars: number;
  maxConcurrent: number;
}

// --- Agents ---------------------------------------------------------------

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Persistent agent identity. Survives restarts, so an agent that reconnects
 * keeps the name and voice the user gave it instead of registering again.
 */
export interface AgentProfile {
  id: string;
  /** Display name: "voice-box #1" by default, or whatever the agent registered. */
  label: string;
  projectPath: string;
  projectName: string;
  voice: VoiceSelection;
  /** Once the user picks a voice, agents may rename but not re-voice. */
  voiceLockedByUser: boolean;
  muted: boolean;
  volume: number;
  /** Stable swatch so the control panel can tell agents apart at a glance. */
  color: string;
  createdAt: string;
  lastSeen: string;
}

/** One live MCP process bound to a profile. Never persisted. */
export interface AgentSession {
  sessionId: string;
  profileId: string;
  pid: number | null;
  client: string;
  clientVersion?: string;
  startedAt: string;
  lastSeenAt: string;
}

// --- Utterances -----------------------------------------------------------

export const UTTERANCE_STATUSES = [
  "queued",
  "synthesizing",
  "playing",
  "played",
  "skipped",
  "expired",
  "dropped",
  "muted",
  "failed",
  "degraded",
] as const;
export type UtteranceStatus = (typeof UTTERANCE_STATUSES)[number];

/** Terminal states: the utterance will never be spoken from here. */
export const TERMINAL_STATUSES: readonly UtteranceStatus[] = [
  "played",
  "skipped",
  "expired",
  "dropped",
  "muted",
  "failed",
  "degraded",
];

export function isTerminal(status: UtteranceStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface Utterance {
  id: string;
  profileId: string;
  agentLabel: string;
  text: string;
  priority: Priority;
  status: UtteranceStatus;
  voice: VoiceSelection;
  enqueuedAt: string;
  expiresAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Human-readable failure or degradation reason. */
  detail?: string;
}

/** User-initiated audio (replay of a history entry, or a voice preview). */
export interface UserPlayback {
  label: string;
  text: string;
  startedAt: string;
}

export interface QueueSnapshot {
  playing: Utterance | null;
  /**
   * In actual play order -- what the panel's #1/#2/#3 badges show. Held
   * agents' items sort after everything playable.
   */
  pending: Utterance[];
  paused: boolean;
  /** True when the current utterance is frozen mid-word by a hard pause. */
  frozenMidUtterance: boolean;
  /** Agents held by a per-agent pause; their queues wait while others play. */
  pausedProfiles: string[];
  /** Set while a replay/preview is sounding outside the agent queue. */
  userPlayback: UserPlayback | null;
}

/**
 * How long a `speak` call waits before returning.
 * - none: return as soon as the request is accepted
 * - accepted: return once admitted, applying per-agent backpressure
 * - played: block until this utterance finishes playing
 */
export const WAIT_MODES = ["none", "accepted", "played"] as const;
export type WaitMode = (typeof WAIT_MODES)[number];
