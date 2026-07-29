import { readJsonFile, writeJsonFileAtomic } from "../../shared/atomicJson.js";
import { ensureHome, getPaths, type VoiceBoxPaths } from "../../shared/paths.js";
import { maskSecret } from "../../shared/redact.js";
import type { ProviderId } from "../../shared/types.js";
import { PROVIDER_IDS } from "../../shared/types.js";
import {
  configSchema,
  defaultConfig,
  defaultSecrets,
  secretsSchema,
  type VoiceBoxConfig,
  type VoiceBoxSecrets,
} from "./schema.js";

/** Where a key came from. Env always wins so a shell can override the UI. */
export type SecretSource = "env" | "file" | null;

const ENV_VARS: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

export interface SecretStatus {
  providerId: ProviderId;
  configured: boolean;
  source: SecretSource;
  /** Masked hint like "sk-…a1b2". The only form a key may leave the daemon in. */
  hint: string | null;
}

/**
 * Owns config.json and secrets.json.
 *
 * Keys are daemon-scoped: a key sitting in an MCP client's `env` block is
 * deliberately not consulted, so there is exactly one place to configure them
 * and no shadowed sources to debug.
 */
export class ConfigStore {
  private constructor(
    readonly paths: VoiceBoxPaths,
    private currentConfig: VoiceBoxConfig,
    private currentSecrets: VoiceBoxSecrets,
  ) {}

  static async load(paths: VoiceBoxPaths = getPaths()): Promise<ConfigStore> {
    await ensureHome(paths);
    const config = (await readJsonFile(paths.configFile, configSchema)) ?? defaultConfig();
    const secrets = (await readJsonFile(paths.secretsFile, secretsSchema)) ?? defaultSecrets();
    return new ConfigStore(paths, config, secrets);
  }

  get config(): VoiceBoxConfig {
    return this.currentConfig;
  }

  /** Apply a change and persist it atomically. */
  async update(mutate: (draft: VoiceBoxConfig) => VoiceBoxConfig): Promise<VoiceBoxConfig> {
    const next = configSchema.parse(mutate(structuredClone(this.currentConfig)));
    await writeJsonFileAtomic(this.paths.configFile, next);
    this.currentConfig = next;
    return next;
  }

  /**
   * Resolve a provider's key. Environment beats the stored file so a one-off
   * `OPENAI_API_KEY=... voice-box daemon` works without touching saved state.
   */
  getApiKey(providerId: ProviderId): string | undefined {
    const fromEnv = process.env[ENV_VARS[providerId]]?.trim();
    if (fromEnv) return fromEnv;
    return this.currentSecrets[providerId]?.apiKey;
  }

  getSecretSource(providerId: ProviderId): SecretSource {
    if (process.env[ENV_VARS[providerId]]?.trim()) return "env";
    if (this.currentSecrets[providerId]?.apiKey) return "file";
    return null;
  }

  async setApiKey(providerId: ProviderId, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error("API key must not be empty");
    const next = secretsSchema.parse({
      ...this.currentSecrets,
      [providerId]: { apiKey: trimmed },
    });
    await writeJsonFileAtomic(this.paths.secretsFile, next);
    this.currentSecrets = next;
  }

  async clearApiKey(providerId: ProviderId): Promise<void> {
    const next = { ...this.currentSecrets };
    delete next[providerId];
    const parsed = secretsSchema.parse(next);
    await writeJsonFileAtomic(this.paths.secretsFile, parsed);
    this.currentSecrets = parsed;
  }

  /** Safe-to-transmit view of which providers are configured. Never the key. */
  describeSecrets(): SecretStatus[] {
    return PROVIDER_IDS.map((providerId) => {
      const key = this.getApiKey(providerId);
      return {
        providerId,
        configured: Boolean(key),
        source: this.getSecretSource(providerId),
        hint: key ? maskSecret(key) : null,
      };
    });
  }

  /** Env var name a user can set to configure this provider from a shell. */
  static envVarFor(providerId: ProviderId): string {
    return ENV_VARS[providerId];
  }
}
