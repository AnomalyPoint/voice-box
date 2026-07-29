/**
 * Structural secret redaction.
 *
 * Every log line and every outbound error passes through here. Relying on
 * discipline ("remember not to log the key") fails eventually; this fails safe
 * by default, which matters because this package holds API keys and is public.
 */

/** Value shapes that are secrets regardless of what key they sit under. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI (incl. sk-proj-)
  /\bsk_[A-Za-z0-9]{16,}/g, // ElevenLabs
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bxi-api-key["'\s:=]+[A-Za-z0-9_-]{16,}/gi,
];

/** Object keys whose values are always secrets, whatever they look like. */
const SECRET_KEY_RE =
  /(^|[_-])(api[_-]?key|apikey|token|secret|password|passwd|authorization|auth|cookie|xi[_-]api[_-]key)([_-]|$)/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redact a value: secret-looking strings anywhere, plus any value sitting
 * under a secret-looking key.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

/**
 * Non-reversible display hint for a configured key, e.g. "sk-…a1b2".
 * This is the ONLY form in which a key is ever allowed to leave the daemon.
 */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < 12) return "•".repeat(Math.max(trimmed.length, 4));
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}
