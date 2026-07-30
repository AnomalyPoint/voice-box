import { z } from "zod";

import { PRIORITIES, PROVIDER_IDS, WAIT_MODES } from "../../shared/types.js";

export const CONFIG_SCHEMA_VERSION = 1;

/** Default daemon port; the daemon falls back through DEFAULT_PORT+10 if taken. */
export const DEFAULT_PORT = 4517;
export const MAX_PORT_ATTEMPTS = 11;

export const voiceSelectionSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  voiceId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  options: z.record(z.unknown()).optional(),
});

export const DEFAULT_VOICE = {
  providerId: "openai" as const,
  voiceId: "nova",
  modelId: "tts-1",
};

/**
 * A persistent agent identity.
 *
 * Sessions are ephemeral and never stored; only this survives a restart, which
 * is what stops an agent from re-registering every time it reconnects.
 */
export const agentProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
  voice: voiceSelectionSchema,
  voiceLockedByUser: z.boolean().default(false),
  muted: z.boolean().default(false),
  volume: z.number().min(0).max(1).default(1),
  color: z.string().default("#6b7fd7"),
  createdAt: z.string(),
  lastSeen: z.string(),
});

/**
 * Non-secret settings. Deliberately free of API keys so this file can be
 * pasted into a bug report without redaction.
 */
export const configSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
  audio: z
    .object({
      /** Backend id from AUDIO_BACKENDS, or "auto" to take the first available. */
      backend: z.string().default("auto"),
      volume: z.number().min(0).max(1).default(1),
      /** Escape hatch: a command line using {file} and {volume} placeholders. */
      customCommand: z.string().optional(),
    })
    .default({}),
  voice: z
    .object({
      default: voiceSelectionSchema.default(DEFAULT_VOICE),
    })
    .default({}),
  daemon: z
    .object({
      port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
      /** 0 means never shut down on its own -- the control panel may still be open. */
    })
    .default({}),
  queue: z
    .object({
      maxDepth: z.number().int().min(1).default(50),
      maxPerAgent: z.number().int().min(1).default(8),
      overflow: z.enum(["dropOldestFromSameAgent", "reject"]).default("dropOldestFromSameAgent"),
      /**
       * The most important knob in the system: "working on this now" heard four
       * minutes late is worse than silence.
       */
      ttlSeconds: z
        .object({
          low: z.number().int().min(1).default(120),
          normal: z.number().int().min(1).default(120),
          high: z.number().int().min(1).default(600),
          urgent: z.number().int().min(1).default(600),
        })
        .default({}),
      /** Per-agent pending depth at which speak starts applying backpressure. */
      backpressureThreshold: z.number().int().min(1).default(2),
      backpressureTimeoutMs: z.number().int().min(0).default(20_000),
      purgeOnDisconnect: z.boolean().default(true),
      defaultWait: z.enum(WAIT_MODES).default("accepted"),
      defaultPriority: z.enum(PRIORITIES).default("normal"),
    })
    .default({}),
  /** Persistent agent identities, keyed by profile id. */
  agents: z.record(agentProfileSchema).default({}),
  /** Per-project overrides, keyed by absolute path. */
  projects: z
    .record(z.object({ defaultVoice: voiceSelectionSchema.optional() }))
    .default({}),
});

export type VoiceBoxConfig = z.infer<typeof configSchema>;

/**
 * API keys, kept in a separate file from config.json.
 * Never logged, never returned over HTTP -- only ever a masked hint.
 */
export const secretsSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
  openai: z.object({ apiKey: z.string().min(1) }).optional(),
  elevenlabs: z.object({ apiKey: z.string().min(1) }).optional(),
});

export type VoiceBoxSecrets = z.infer<typeof secretsSchema>;

export function defaultConfig(): VoiceBoxConfig {
  return configSchema.parse({});
}

export function defaultSecrets(): VoiceBoxSecrets {
  return secretsSchema.parse({});
}
