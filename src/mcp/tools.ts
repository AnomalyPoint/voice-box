import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toVoiceBoxError } from "../shared/errors.js";
import type { Logger } from "../shared/log.js";
import { PRIORITIES, WAIT_MODES } from "../shared/types.js";
import type { AgentConnection } from "./connection.js";

const MAX_TEXT_LENGTH = 4000;

/** Shared error shaping so every tool fails the same, legible way. */
function failure(error: unknown, logger: Logger) {
  const mapped = toVoiceBoxError(error);
  logger.error("tool failed", { code: mapped.code, message: mapped.message });
  return {
    content: [{ type: "text" as const, text: mapped.toDisplayString() }],
    isError: true,
  };
}

export function registerTools(
  server: McpServer,
  connection: AgentConnection,
  logger: Logger,
): void {
  server.registerTool(
    "speak",
    {
      title: "Speak out loud",
      description:
        "Say something out loud through the user's speakers. Use this for brief spoken " +
        "updates -- starting a task, finishing one, hitting a problem, or asking a question -- " +
        "the way a colleague would talk while working. Keep it to a sentence or two of natural " +
        "speech; put detail (code, paths, errors, lists) in your text reply instead, because " +
        "speech cannot be skimmed. IMPORTANT: this returns as soon as the utterance is queued, " +
        "NOT when it finishes playing, so do not treat the response as proof the user heard it, " +
        "and do not repeat yourself. Audio from all agents on this machine plays one at a time. " +
        "The user assigns your voice from the control panel; you cannot choose it.",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_TEXT_LENGTH)
          .describe("What to say. A sentence or two of natural speech."),
        priority: z
          .enum(PRIORITIES)
          .optional()
          .describe(
            "Queue priority. Use 'high' only when the user is actually blocked; " +
              "default 'normal' is right for almost everything.",
          ),
        wait: z
          .enum(WAIT_MODES)
          .optional()
          .describe("'played' blocks until playback finishes. Rarely needed."),
      },
      outputSchema: {
        status: z.string().describe("queued, muted, throttled, played, or a terminal state."),
        queuePosition: z.number(),
        etaSeconds: z.number(),
        agent: z.string(),
        voice: z.string(),
        note: z.string().optional(),
      },
      // Not readOnly: it plays audio and spends provider credits.
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ text, priority, wait }) => {
      try {
        const { response, session, firstSeen } = await connection.speak({
          text,
          ...(priority !== undefined ? { priority } : {}),
          ...(wait !== undefined ? { wait } : {}),
        });

        const notes: string[] = [];
        if (firstSeen) {
          notes.push(
            `You are registered as "${response.agent.name}" using the ${response.agent.voice} voice. ` +
              `Tell the user they can rename you or change the voice at ${session.panelUrl}.`,
          );
        }
        if (response.status === "muted") {
          notes.push("This agent is muted in the control panel, so nothing was spoken.");
        }
        if (response.status === "throttled") {
          notes.push("You are queuing faster than the speaker can keep up. Speak less often.");
        }
        if (response.warning) notes.push(response.warning);
        if (session.audioWarning) notes.push(session.audioWarning);

        const note = notes.join(" ");
        const summary =
          response.status === "muted"
            ? "Muted -- not spoken."
            : `Queued at position ${response.queuePosition} (~${response.etaSeconds}s) as ${response.agent.name}.`;

        return {
          content: [{ type: "text" as const, text: note ? `${summary} ${note}` : summary }],
          structuredContent: {
            status: response.status,
            queuePosition: response.queuePosition,
            etaSeconds: response.etaSeconds,
            agent: response.agent.name,
            voice: response.agent.voice,
            ...(note ? { note } : {}),
          },
        };
      } catch (error) {
        return failure(error, logger);
      }
    },
  );

  server.registerTool(
    "voice_register",
    {
      title: "Set this agent's display name",
      description:
        "Give yourself a name in the Voice Box control panel, e.g. your persona name. " +
        "You already have a working identity and voice without calling this -- it only " +
        "renames what you have, so calling it once per session at most is plenty. It never " +
        "creates a second agent. If the user has assigned you a voice in the panel, that " +
        "choice wins and any voice you request here is ignored.",
      inputSchema: {
        name: z.string().min(1).max(60).describe("The display name, e.g. \"Max\"."),
      },
      outputSchema: {
        agent: z.string(),
        voice: z.string(),
        panelUrl: z.string(),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      try {
        const result = await connection.register(name);
        const note = result.voiceLocked
          ? "The user has locked your voice in the control panel, so it was left unchanged."
          : undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: `Registered as "${result.label}" with the ${result.voice} voice. Manage agents at ${result.panelUrl}.`,
            },
          ],
          structuredContent: {
            agent: result.label,
            voice: result.voice,
            panelUrl: result.panelUrl,
            ...(note ? { note } : {}),
          },
        };
      } catch (error) {
        return failure(error, logger);
      }
    },
  );

  server.registerTool(
    "voice_status",
    {
      title: "Check the speech queue",
      description:
        "See who is speaking, what is queued, and how this agent is configured. Useful when " +
        "you want to know whether the user actually heard something, or whether you are muted.",
      inputSchema: {},
      outputSchema: {
        agent: z.string(),
        voice: z.string(),
        muted: z.boolean(),
        paused: z.boolean(),
        nowPlaying: z.string().optional(),
        queueDepth: z.number(),
        panelUrl: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const { session, state } = await connection.status();
        const profile =
          state.profiles.find((entry) => entry.id === session.profile.id) ?? session.profile;
        const nowPlaying = state.queue.playing
          ? `${state.queue.playing.agentLabel}: ${state.queue.playing.text.slice(0, 60)}`
          : undefined;

        const structuredContent = {
          agent: profile.label,
          voice: `${profile.voice.providerId}/${profile.voice.voiceId}`,
          muted: profile.muted,
          paused: state.queue.paused,
          ...(nowPlaying !== undefined ? { nowPlaying } : {}),
          queueDepth: state.queue.pending.length,
          panelUrl: state.panelUrl,
        };

        return {
          content: [
            {
              type: "text" as const,
              text:
                `You are "${profile.label}" (${structuredContent.voice})` +
                `${profile.muted ? ", muted" : ""}${state.queue.paused ? ", playback paused" : ""}. ` +
                `${state.queue.pending.length} utterance(s) queued.` +
                (nowPlaying ? ` Now playing -- ${nowPlaying}` : ""),
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return failure(error, logger);
      }
    },
  );
}
