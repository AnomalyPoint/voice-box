import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";

import { VoiceBoxError } from "../../shared/errors.js";
import type { DetectedBackend } from "../audio/index.js";
import { maskSecret } from "../../shared/redact.js";
import { PROVIDER_IDS, type ProviderId } from "../../shared/types.js";
import { voiceSelectionSchema } from "../config/schema.js";
import type { DaemonContext } from "../main.js";
import { secretsMatch } from "./auth.js";
import { HANDLED, type Route } from "./server.js";

const SESSION_COOKIE = "voicebox_token";

const sessionBody = z.object({ token: z.string().min(1) });
const secretBody = z.object({ apiKey: z.string().min(8) });
const previewBody = z.object({ voice: voiceSelectionSchema, text: z.string().max(200).optional() });

const configPatchBody = z.object({
  audio: z
    .object({ backend: z.string().optional(), volume: z.number().min(0).max(1).optional() })
    .optional(),
  queue: z
    .object({
      maxPerAgent: z.number().int().min(1).max(50).optional(),
      ttlSeconds: z
        .object({
          low: z.number().int().min(1).optional(),
          normal: z.number().int().min(1).optional(),
          high: z.number().int().min(1).optional(),
          urgent: z.number().int().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  voice: z.object({ default: voiceSelectionSchema.optional() }).optional(),
});

function requireProviderId(value: string): ProviderId {
  if (!(PROVIDER_IDS as readonly string[]).includes(value)) {
    throw new VoiceBoxError("invalid_input", `Unknown provider "${value}".`);
  }
  return value as ProviderId;
}

/** Routes used only by the control panel. */
export function buildPanelRoutes(ctx: DaemonContext): Route[] {
  return [
    {
      method: "POST",
      path: "/session",
      // Public because this IS the authentication bootstrap: the page arrives
      // holding the token in its URL fragment and trades it for a cookie.
      public: true,
      handler: async (request) => {
        const body = await request.body(sessionBody);
        if (!secretsMatch(body.token, ctx.state.token)) {
          throw new VoiceBoxError("invalid_input", "Invalid token.");
        }
        // HttpOnly so panel scripts cannot read it back out; SameSite=Strict so
        // no other site can ride it.
        request.res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=${encodeURIComponent(ctx.state.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        return { ok: true };
      },
    },

    {
      method: "GET",
      path: "/events",
      handler: (request) => {
        ctx.hub.subscribe(request.req, request.res);
        return HANDLED;
      },
    },

    {
      method: "GET",
      path: "/config",
      handler: () => ({
        config: ctx.store.config,
        // Only ever a masked hint; the raw key never leaves the daemon.
        providers: ctx.store.describeSecrets().map((status) => ({
          ...status,
          displayName: ctx.providers.require(status.providerId).displayName,
          envVar: ctx.providers.require(status.providerId).envVar,
        })),
        audio: {
          selected: ctx.player.backend,
          available: ctx.audioReport.available.map((entry: DetectedBackend) => ({
            id: entry.spec.id,
            label: entry.spec.label,
          })),
          missing: ctx.audioReport.missing,
        },
      }),
    },

    {
      method: "PATCH",
      path: "/config",
      handler: async (request) => {
        const patch = await request.body(configPatchBody);
        const next = await ctx.store.update((draft) => ({
          ...draft,
          audio: { ...draft.audio, ...patch.audio },
          queue: {
            ...draft.queue,
            ...patch.queue,
            ttlSeconds: { ...draft.queue.ttlSeconds, ...patch.queue?.ttlSeconds },
          },
          voice: { ...draft.voice, ...patch.voice },
        }));
        ctx.hub.emit("config", { config: next });
        return { config: next };
      },
    },

    {
      method: "PUT",
      path: "/secrets/:provider",
      handler: async (request) => {
        const providerId = requireProviderId(request.params["provider"] ?? "");
        const body = await request.body(secretBody);
        const provider = ctx.providers.require(providerId);

        // Verify before persisting, so a typo is caught at entry rather than
        // surfacing later as a mysterious failure to speak.
        const verification = await provider.verifyKey(body.apiKey);
        if (!verification.ok) {
          throw new VoiceBoxError("provider_auth", verification.detail ?? "The key was rejected.");
        }

        await ctx.store.setApiKey(providerId, body.apiKey);
        ctx.logger.info("api key updated", { provider: providerId });
        ctx.hub.emit("config", { providers: ctx.store.describeSecrets() });
        return { configured: true, hint: maskSecret(body.apiKey) };
      },
    },

    {
      method: "DELETE",
      path: "/secrets/:provider",
      handler: async (request) => {
        const providerId = requireProviderId(request.params["provider"] ?? "");
        await ctx.store.clearApiKey(providerId);
        ctx.hub.emit("config", { providers: ctx.store.describeSecrets() });
        return { configured: false };
      },
    },

    {
      method: "GET",
      path: "/history",
      handler: async () => ({ entries: await ctx.history.recent() }),
    },

    {
      method: "DELETE",
      path: "/history",
      handler: async () => {
        await ctx.history.clear();
        ctx.hub.emit("history", { cleared: true });
        return { ok: true };
      },
    },

    {
      method: "GET",
      path: "/audio/:key",
      handler: async (request) => {
        const key = request.params["key"] ?? "";
        // Content-addressed keys are hex sha256; reject anything else outright
        // rather than letting a crafted name reach the filesystem.
        if (!/^[a-f0-9]{64}$/.test(key)) {
          throw new VoiceBoxError("invalid_input", "Invalid audio id.");
        }
        const file = ctx.cache.pathFor(key);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) {
          throw new VoiceBoxError("invalid_input", "That audio is no longer cached.");
        }
        request.res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": info.size,
        });
        createReadStream(file).pipe(request.res);
        return HANDLED;
      },
    },

    {
      method: "POST",
      path: "/preview",
      handler: async (request) => {
        const body = await request.body(previewBody);
        const provider = ctx.providers.require(body.voice.providerId);
        if (!provider.isConfigured()) throw ctx.providers.notConfiguredError();

        // Play straight through, bypassing the queue: this is the user clicking
        // a button, not an agent talking, and it should be immediate.
        const audio = await ctx.synthesizer.synthesize(
          body.text ?? "This is how this voice sounds.",
          body.voice,
        );
        const outcome = await ctx.player.play(audio.file, { volume: ctx.store.config.audio.volume })
          .done;
        return { played: outcome.status === "completed", audioKey: audio.key };
      },
    },

    {
      method: "DELETE",
      path: "/agents/:id",
      handler: async (request) => {
        const profileId = request.params["id"] ?? "";
        ctx.registry.requireProfile(profileId);
        if (ctx.registry.sessionsFor(profileId).length > 0) {
          throw new VoiceBoxError("invalid_input", "That agent is currently connected.");
        }
        await ctx.registry.removeProfile(profileId);
        ctx.hub.emit("state", { removed: profileId });
        return { ok: true };
      },
    },
  ];
}
