import { isVoiceBoxError } from "../shared/errors.js";
import type { Logger } from "../shared/log.js";
import type {
  RegisterSessionResponse,
  SpeakRequest,
  SpeakResponse,
  StateResponse,
} from "../shared/protocol.js";
import type { DaemonState } from "../shared/protocol.js";
import type { VoiceSelection } from "../shared/types.js";
import { DaemonClient, deriveIdentity } from "./daemonClient.js";
import { ensureDaemon } from "./ensureDaemon.js";

export interface ClientInfo {
  name: string;
  version?: string;
}

/** Seam for tests; production uses the real daemon discovery and client. */
export interface ConnectionDeps {
  ensureDaemon: typeof ensureDaemon;
  createClient: (state: DaemonState) => DaemonClient;
}

/**
 * True when the daemon no longer knows the session we sent -- it restarted or
 * reaped us. This is the one failure re-registering is guaranteed to fix.
 *
 * Daemons that predate the dedicated code report it as invalid_input with this
 * exact message, and ensureDaemon reuses any healthy daemon regardless of
 * version, so the message fallback is a normal path, not a paranoid one.
 */
export function isUnknownSessionError(error: unknown): boolean {
  if (!isVoiceBoxError(error)) return false;
  if (error.code === "unknown_session") return true;
  return error.code === "invalid_input" && error.message.startsWith("Unknown session.");
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
    private readonly deps: ConnectionDeps = {
      ensureDaemon,
      createClient: (state) => new DaemonClient(state),
    },
  ) {}

  /** Idempotent: concurrent callers share one registration, never two. */
  private async ensureSession(): Promise<RegisterSessionResponse> {
    if (this.session) return this.session;
    if (this.pending) return this.pending;

    this.pending = (async () => {
      const { state } = await this.deps.ensureDaemon(this.logger);
      this.client = this.deps.createClient(state);

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
   * Drop the cached session, but only if it is still the one that failed.
   * A stale failure must never clobber a session someone else just registered.
   */
  private invalidateSession(failed: RegisterSessionResponse): void {
    if (this.session?.sessionId === failed.sessionId) this.session = undefined;
  }

  /**
   * Run a session-scoped request, re-registering and retrying exactly once if
   * the daemon has forgotten us (it restarted; sessions live in memory).
   * Without this, one `voice-box restart` breaks every connected agent's
   * `speak` for the life of its MCP process.
   */
  private async withSession<T>(
    run: (client: DaemonClient, session: RegisterSessionResponse) => Promise<T>,
  ): Promise<{ result: T; session: RegisterSessionResponse }> {
    const session = await this.ensureSession();
    try {
      return { result: await run(this.client!, session), session };
    } catch (error) {
      if (!isUnknownSessionError(error)) throw error;
      this.invalidateSession(session);
      const fresh = await this.ensureSession();
      try {
        return { result: await run(this.client!, fresh), session: fresh };
      } catch (retryError) {
        // Restarted again mid-retry. Give up for this call, but clear the
        // cache so the next tool call starts from a clean registration.
        if (isUnknownSessionError(retryError)) this.invalidateSession(fresh);
        throw retryError;
      }
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
    const { result: response, session } = await this.withSession((client, current) =>
      client.speak({ ...request, sessionId: current.sessionId }),
    );
    return { response, session, firstSeen: this.takeFirstSeen(session) };
  }

  async register(
    name: string,
    voice?: VoiceSelection,
  ): Promise<{ label: string; voice: string; voiceLocked: boolean; panelUrl: string }> {
    const { result, session } = await this.withSession((client, current) =>
      client.registerAgent({
        sessionId: current.sessionId,
        name,
        ...(voice !== undefined ? { voice } : {}),
      }),
    );
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
