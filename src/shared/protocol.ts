/**
 * Wire contracts between the thin MCP client, the control panel, and the daemon.
 *
 * Keep this file additive: an MCP client resolved from one npx cache can meet a
 * daemon from another, and the version negotiation only handles major changes.
 */
import type {
  AgentProfile,
  AgentSession,
  Priority,
  QueueSnapshot,
  UtteranceStatus,
  VoiceDescriptor,
  VoiceSelection,
  WaitMode,
} from "./types.js";
import type { VoiceBoxErrorCode } from "./errors.js";

export const API_PREFIX = "/v1";

/** Identifies a real Voice Box daemon, as opposed to anything else on the port. */
export const SERVICE_NAME = "voice-box";

/** Header used to prove a state-changing request was not a cross-origin form post. */
export const REQUESTED_WITH_HEADER = "x-requested-with";
export const REQUESTED_WITH_VALUE = "voice-box";

// --- Daemon state file ----------------------------------------------------

export interface DaemonState {
  schemaVersion: 1;
  pid: number;
  port: number;
  host: string;
  /** Bearer token, regenerated on every daemon start. */
  token: string;
  pkgVersion: string;
  protocolVersion: number;
  startedAt: string;
}

// --- Health ---------------------------------------------------------------

/**
 * Deliberately unauthenticated and minimal.
 *
 * Two daemons racing for the same port must be able to recognise each other,
 * and a challenger cannot know the incumbent's token -- so identity has to be
 * readable without one. Nothing here is sensitive: it says only that a Voice
 * Box daemon owns this port. Host/Origin checks still apply, so a web page
 * cannot read it either. Everything substantive lives behind /v1/state.
 */
export interface HealthResponse {
  service: typeof SERVICE_NAME;
  pkgVersion: string;
  protocolVersion: number;
  pid: number;
  port: number;
  uptimeMs: number;
}

// --- Sessions -------------------------------------------------------------

export interface RegisterSessionRequest {
  projectPath: string;
  projectName: string;
  /** MCP clientInfo name, e.g. "claude-code". */
  client: string;
  clientVersion?: string;
  pid: number | null;
  /** Optional name supplied via VOICE_BOX_AGENT_NAME. */
  preferredLabel?: string;
}

export interface RegisterSessionResponse {
  sessionId: string;
  profile: AgentProfile;
  /** True when this profile was created rather than reused. */
  firstSeen: boolean;
  /** Where the human can change the voice. */
  panelUrl: string;
  /** Set when the daemon has no usable audio backend. */
  audioWarning?: string;
}

export interface RegisterAgentRequest {
  sessionId: string;
  /** Friendly name the agent wants, e.g. "Max". */
  name: string;
  /** Ignored once the user has picked a voice in the panel. */
  voice?: VoiceSelection;
}

export interface RegisterAgentResponse {
  profile: AgentProfile;
  /** True when a requested voice was ignored because the user locked it. */
  voiceLocked: boolean;
}

// --- Speaking -------------------------------------------------------------

export interface SpeakRequest {
  sessionId: string;
  text: string;
  priority?: Priority;
  wait?: WaitMode;
}

export interface SpeakResponse {
  id: string;
  status: UtteranceStatus | "throttled";
  /** 0 while playing, 1-based position among pending items. */
  queuePosition: number;
  etaSeconds: number;
  agent: { name: string; voice: string };
  firstSeen?: boolean;
  warning?: string;
}

// --- State / control ------------------------------------------------------

export interface StateResponse {
  daemon: { pid: number; port: number; host: string; version: string; uptimeMs: number };
  profiles: AgentProfile[];
  sessions: AgentSession[];
  queue: QueueSnapshot;
  providers: { id: string; displayName: string; configured: boolean; hint: string | null }[];
  audioBackend: { id: string; label: string; executable: string | null };
  panelUrl: string;
}

export interface VoicesResponse {
  voices: VoiceDescriptor[];
}

export type TransportCommand =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "skip"; id?: string }
  | { action: "clear"; profileId?: string };

// --- Errors ---------------------------------------------------------------

export interface ErrorBody {
  error: {
    code: VoiceBoxErrorCode;
    message: string;
    hint?: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
}

export function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ErrorBody).error?.code === "string"
  );
}
