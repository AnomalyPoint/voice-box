import { z } from "zod";

import { VoiceBoxError } from "../../shared/errors.js";
import type {
  HealthResponse,
  RegisterAgentResponse,
  RegisterSessionResponse,
  SpeakResponse,
  StateResponse,
} from "../../shared/protocol.js";
import { SERVICE_NAME } from "../../shared/protocol.js";
import { PRIORITIES, WAIT_MODES } from "../../shared/types.js";
import { PKG_VERSION, PROTOCOL_VERSION } from "../../version.js";
import { voiceSelectionSchema } from "../config/schema.js";
import type { DaemonContext } from "../main.js";
import type { Route } from "./server.js";

const registerSessionBody = z.object({
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
  client: z.string().min(1),
  clientVersion: z.string().optional(),
  pid: z.number().int().nullable(),
  preferredLabel: z.string().min(1).optional(),
});

const registerAgentBody = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1).max(60),
  voice: voiceSelectionSchema.optional(),
});

const speakBody = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(4000),
  priority: z.enum(PRIORITIES).optional(),
  wait: z.enum(WAIT_MODES).optional(),
});

const commandBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("skip"), id: z.string().optional() }),
  z.object({ action: z.literal("play_now"), id: z.string().min(1) }),
  z.object({ action: z.literal("clear"), profileId: z.string().optional() }),
]);

const voicePatchBody = z.object({
  voice: voiceSelectionSchema.optional(),
  label: z.string().min(1).max(60).optional(),
  muted: z.boolean().optional(),
  volume: z.number().min(0).max(1).optional(),
});

export function buildRoutes(ctx: DaemonContext): Route[] {
  const panelUrl = () => `http://${ctx.state.host}:${ctx.state.port}`;
  // Any change to who is connected or what they are called goes to the panel
  // at once -- a new agent must appear before it ever speaks.
  const emitState = () =>
    ctx.hub.emit("state", {
      profiles: ctx.registry.listProfiles(),
      sessions: ctx.registry.listSessions(),
    });

  return [
    {
      method: "GET",
      path: "/health",
      // Unauthenticated by design: a daemon racing for this port must be able
      // to recognise an incumbent whose token it cannot know.
      public: true,
      handler: (): HealthResponse => ({
        service: SERVICE_NAME,
        pkgVersion: PKG_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        port: ctx.state.port,
        uptimeMs: Date.now() - Date.parse(ctx.state.startedAt),
      }),
    },

    {
      method: "POST",
      path: "/sessions",
      handler: async (request): Promise<RegisterSessionResponse> => {
        const body = await request.body(registerSessionBody);
        const binding = await ctx.registry.registerSession(body);
        emitState();
        const audioWarning =
          ctx.player.backend.executable === null
            ? "No audio player was found, so speech will not be audible."
            : undefined;

        return {
          sessionId: binding.session.sessionId,
          profile: binding.profile,
          firstSeen: binding.firstSeen,
          panelUrl: panelUrl(),
          ...(audioWarning !== undefined ? { audioWarning } : {}),
        };
      },
    },

    {
      method: "DELETE",
      path: "/sessions/:id",
      handler: (request) => {
        const session = ctx.registry.endSession(request.params["id"] ?? "");
        if (session) {
          ctx.scheduler.onSessionEnd(session.profileId);
          emitState();
        }
        return { ok: true };
      },
    },

    {
      method: "POST",
      path: "/agents/register",
      handler: async (request): Promise<RegisterAgentResponse> => {
        const body = await request.body(registerAgentBody);
        const session = ctx.registry.requireSession(body.sessionId);

        // Rename in place rather than creating: this is why calling register
        // repeatedly cannot fan out into duplicate identities.
        let profile = await ctx.registry.rename(session.profileId, body.name);
        let voiceLocked = false;

        if (body.voice) {
          const result = await ctx.registry.setVoice(session.profileId, body.voice, "agent");
          profile = result.profile;
          voiceLocked = !result.applied;
        }
        return { profile, voiceLocked };
      },
    },

    {
      method: "POST",
      path: "/speak",
      handler: async (request): Promise<SpeakResponse> => {
        const body = await request.body(speakBody);
        const outcome = await ctx.scheduler.speak(body);
        return {
          id: outcome.id,
          status: outcome.status,
          queuePosition: outcome.queuePosition,
          etaSeconds: outcome.etaSeconds,
          agent: { name: outcome.agentLabel, voice: outcome.voiceLabel },
          ...(outcome.warning !== undefined ? { warning: outcome.warning } : {}),
        };
      },
    },

    {
      method: "GET",
      path: "/state",
      handler: (): StateResponse => ({
        daemon: {
          pid: process.pid,
          port: ctx.state.port,
          host: ctx.state.host,
          version: PKG_VERSION,
          uptimeMs: Date.now() - Date.parse(ctx.state.startedAt),
        },
        profiles: ctx.registry.listProfiles(),
        sessions: ctx.registry.listSessions(),
        queue: ctx.scheduler.snapshot(),
        providers: ctx.store.describeSecrets().map((status) => ({
          id: status.providerId,
          displayName: ctx.providers.require(status.providerId).displayName,
          configured: status.configured,
          hint: status.hint,
        })),
        audioBackend: {
          id: ctx.player.backend.id,
          label: ctx.player.backend.label,
          executable: ctx.player.backend.executable,
        },
        panelUrl: panelUrl(),
      }),
    },

    {
      method: "POST",
      path: "/queue/commands",
      handler: async (request) => {
        const command = await request.body(commandBody);
        switch (command.action) {
          case "pause":
            ctx.scheduler.pause();
            return { ok: true, paused: true };
          case "resume":
            ctx.scheduler.resume();
            return { ok: true, paused: false };
          case "skip":
            return { ok: ctx.scheduler.skip(command.id) };
          case "play_now":
            return { ok: ctx.scheduler.playNow(command.id) };
          case "clear":
            return { ok: true, cleared: ctx.scheduler.clear(command.profileId) };
        }
      },
    },

    {
      method: "PATCH",
      path: "/agents/:id",
      handler: async (request) => {
        const profileId = request.params["id"] ?? "";
        const body = await request.body(voicePatchBody);
        let profile = ctx.registry.requireProfile(profileId);

        if (body.label !== undefined) profile = await ctx.registry.rename(profileId, body.label);
        if (body.voice !== undefined) {
          // Origin "user" locks the voice so agents stop overriding it.
          profile = (await ctx.registry.setVoice(profileId, body.voice, "user")).profile;
        }
        if (body.muted !== undefined) profile = await ctx.registry.setMuted(profileId, body.muted);
        if (body.volume !== undefined) {
          profile = await ctx.registry.setVolume(profileId, body.volume);
        }
        emitState();
        return { profile };
      },
    },

    {
      method: "POST",
      path: "/admin/restart",
      handler: () => {
        // Used when a newer client meets an older daemon. Exit cleanly and let
        // the client respawn its own version.
        ctx.logger.info("restart requested by a client");
        setTimeout(() => ctx.requestShutdown("restart requested"), 50).unref();
        return { ok: true };
      },
    },

    {
      method: "GET",
      path: "/voices/:provider",
      handler: async (request) => {
        const providerId = request.params["provider"] ?? "";
        if (providerId !== "openai" && providerId !== "elevenlabs") {
          throw new VoiceBoxError("invalid_input", `Unknown provider "${providerId}".`);
        }
        return { voices: await ctx.providers.require(providerId).listVoices() };
      },
    },
  ];
}
