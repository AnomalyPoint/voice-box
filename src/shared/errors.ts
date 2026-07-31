/**
 * Machine-readable error codes. These cross the MCP tool boundary and the HTTP
 * API, so agents and the web UI can react to them without string matching.
 */
export type VoiceBoxErrorCode =
  | "not_configured"
  | "invalid_input"
  | "unknown_session"
  | "text_too_long"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_error"
  | "no_audio_backend"
  | "playback_failed"
  | "config_invalid"
  | "daemon_unavailable"
  | "internal";

export interface VoiceBoxErrorOptions {
  /** Actionable next step for a human, e.g. "Add a key at http://127.0.0.1:4517". */
  hint?: string;
  /** True when retrying the same operation could plausibly succeed. */
  retryable?: boolean;
  /** Seconds to wait before retrying, when the provider told us. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class VoiceBoxError extends Error {
  readonly code: VoiceBoxErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: VoiceBoxErrorCode, message: string, options: VoiceBoxErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "VoiceBoxError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Message plus hint, for display to a human or an agent. */
  toDisplayString(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message;
  }

  toJSON(): {
    code: VoiceBoxErrorCode;
    message: string;
    hint?: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      retryable: this.retryable,
      ...(this.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: this.retryAfterSeconds }
        : {}),
    };
  }
}

export function isVoiceBoxError(value: unknown): value is VoiceBoxError {
  return value instanceof VoiceBoxError;
}

/** Normalize anything thrown into a VoiceBoxError without losing the original. */
export function toVoiceBoxError(value: unknown, fallbackMessage = "Unexpected error"): VoiceBoxError {
  if (isVoiceBoxError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new VoiceBoxError("internal", message || fallbackMessage, { cause: value });
}

/** Short message suitable for logs, never including a stack. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
