import { basename } from "node:path";

import { VoiceBoxError } from "../shared/errors.js";
import {
  API_PREFIX,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  isErrorBody,
  type DaemonState,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  type RegisterSessionResponse,
  type SpeakRequest,
  type SpeakResponse,
  type StateResponse,
} from "../shared/protocol.js";

export interface AgentIdentity {
  projectPath: string;
  projectName: string;
  client: string;
  clientVersion?: string;
  pid: number;
  preferredLabel?: string;
}

/**
 * Derive an agent's identity from what the MCP process already knows.
 *
 * The point is that the model does not have to do anything: cwd and pid are
 * free, so an agent gets a durable identity even if it never registers.
 */
export function deriveIdentity(client: string, clientVersion?: string): AgentIdentity {
  const projectPath = process.cwd();
  const preferredLabel = process.env["VOICE_BOX_AGENT_NAME"]?.trim();
  return {
    projectPath,
    projectName: basename(projectPath) || "agent",
    client,
    ...(clientVersion !== undefined ? { clientVersion } : {}),
    pid: process.pid,
    ...(preferredLabel ? { preferredLabel } : {}),
  };
}

/** Typed HTTP client for the local daemon. */
export class DaemonClient {
  constructor(private readonly state: DaemonState) {}

  get panelUrl(): string {
    return `http://${this.state.host}:${this.state.port}`;
  }

  registerSession(identity: AgentIdentity): Promise<RegisterSessionResponse> {
    return this.request("POST", "/sessions", identity);
  }

  endSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  registerAgent(body: RegisterAgentRequest): Promise<RegisterAgentResponse> {
    return this.request("POST", "/agents/register", body);
  }

  speak(body: SpeakRequest): Promise<SpeakResponse> {
    return this.request("POST", "/speak", body);
  }

  state_(): Promise<StateResponse> {
    return this.request("GET", "/state");
  }

  command(body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/queue/commands", body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.panelUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.state.token}`,
          [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new VoiceBoxError("daemon_unavailable", "Lost contact with the Voice Box daemon.", {
        hint: "Run `voice-box restart`.",
        cause: error,
      });
    }

    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      if (isErrorBody(payload)) {
        const { code, message, hint, retryable, retryAfterSeconds } = payload.error;
        throw new VoiceBoxError(code, message, {
          ...(hint !== undefined ? { hint } : {}),
          retryable,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
      }
      throw new VoiceBoxError("internal", `Daemon returned ${response.status}.`);
    }

    return payload as T;
  }
}
