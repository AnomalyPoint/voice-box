import type { Logger } from "../shared/log.js";
import type {
  RegisterSessionResponse,
  SpeakRequest,
  SpeakResponse,
  StateResponse,
} from "../shared/protocol.js";
import type { VoiceSelection } from "../shared/types.js";
import { DaemonClient, deriveIdentity } from "./daemonClient.js";
import { ensureDaemon } from "./ensureDaemon.js";

export interface ClientInfo {
  name: string;
  version?: string;
}

/**
 * This agent's connection to the daemon.
 *
 * Session registration is lazy so it happens after the MCP `initialize`
 * handshake, when the client's name is actually known -- registering at
 * startup would label every agent "unknown".
 */
export class AgentConnection {
  private client: DaemonClient | undefined;
  private session: RegisterSessionResponse | undefined;
  private pending: Promise<RegisterSessionResponse> | undefined;
  private firstSeenAnnounced = false;

  constructor(
    private readonly getClientInfo: () => ClientInfo | undefined,
    private readonly logger: Logger,
  ) {}

  /** Idempotent: concurrent callers share one registration, never two. */
  private async ensureSession(): Promise<RegisterSessionResponse> {
    if (this.session) return this.session;
    if (this.pending) return this.pending;

    this.pending = (async () => {
      const { state } = await ensureDaemon(this.logger);
      this.client = new DaemonClient(state);

      const info = this.getClientInfo();
      const identity = deriveIdentity(info?.name ?? "unknown", info?.version);
      const session = await this.client.registerSession(identity);

      this.logger.info(session.firstSeen ? "registered new agent" : "reconnected", {
        label: session.profile.label,
        voice: `${session.profile.voice.providerId}/${session.profile.voice.voiceId}`,
      });
      this.session = session;
      return session;
    })();

    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  /**
   * Consume the "this is a brand new agent" flag exactly once, so the agent
   * announces its name and voice on first contact and never repeats it.
   */
  private takeFirstSeen(session: RegisterSessionResponse): boolean {
    if (!session.firstSeen || this.firstSeenAnnounced) return false;
    this.firstSeenAnnounced = true;
    return true;
  }

  async speak(request: Omit<SpeakRequest, "sessionId">): Promise<{
    response: SpeakResponse;
    session: RegisterSessionResponse;
    firstSeen: boolean;
  }> {
    const session = await this.ensureSession();
    const response = await this.client!.speak({ ...request, sessionId: session.sessionId });
    return { response, session, firstSeen: this.takeFirstSeen(session) };
  }

  async register(
    name: string,
    voice?: VoiceSelection,
  ): Promise<{ label: string; voice: string; voiceLocked: boolean; panelUrl: string }> {
    const session = await this.ensureSession();
    const result = await this.client!.registerAgent({
      sessionId: session.sessionId,
      name,
      ...(voice !== undefined ? { voice } : {}),
    });
    // Keep the cached profile in step so later calls report the new name.
    session.profile = result.profile;
    this.takeFirstSeen(session);
    return {
      label: result.profile.label,
      voice: `${result.profile.voice.providerId}/${result.profile.voice.voiceId}`,
      voiceLocked: result.voiceLocked,
      panelUrl: session.panelUrl,
    };
  }

  async status(): Promise<{ session: RegisterSessionResponse; state: StateResponse }> {
    const session = await this.ensureSession();
    return { session, state: await this.client!.state_() };
  }

  /** Best-effort: lets the daemon purge this agent's backlog promptly. */
  async close(): Promise<void> {
    if (!this.client || !this.session) return;
    await this.client.endSession(this.session.sessionId).catch(() => {});
  }
}
