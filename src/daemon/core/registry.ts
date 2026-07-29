import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { isProcessAlive } from "../../shared/daemonState.js";
import { VoiceBoxError } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import type { RegisterSessionRequest } from "../../shared/protocol.js";
import type { AgentProfile, AgentSession, VoiceSelection } from "../../shared/types.js";
import type { ConfigStore } from "../config/store.js";
import type { ProviderRegistry } from "../providers/registry.js";

/** Distinct swatches so the panel can tell agents apart at a glance. */
const COLORS = [
  "#6b7fd7",
  "#d77b6b",
  "#6bd79c",
  "#d7c96b",
  "#a86bd7",
  "#6bc7d7",
  "#d76ba8",
  "#8fd76b",
];

export interface SessionBinding {
  session: AgentSession;
  profile: AgentProfile;
  /** True when the profile was created for this session rather than reused. */
  firstSeen: boolean;
}

/** Grace period for sessions whose process id we never learned. */
const PIDLESS_SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Owns the Profile (persistent) / Session (ephemeral) split.
 *
 * The whole point is that an agent never has to register: the MCP process
 * already knows its cwd and pid, so it can claim a durable identity with no
 * cooperation from the model. Registering only renames what it already has.
 */
export class AgentRegistry {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly store: ConfigStore,
    private readonly providers: ProviderRegistry,
    private readonly logger: Logger,
  ) {}

  /**
   * Bind a new MCP process to a profile.
   *
   * Reuse rules, in order:
   *   1. a profile for this project that no live session holds -- so restarting
   *      an agent keeps its name and voice and creates nothing;
   *   2. otherwise a new profile with the next free slot number and an unused
   *      voice, so two agents in one folder are audibly distinguishable.
   */
  async registerSession(request: RegisterSessionRequest): Promise<SessionBinding> {
    const projectPath = request.projectPath;
    const projectName = request.projectName || basename(projectPath) || "agent";

    // Drop sessions whose process is gone before deciding which profiles are
    // taken. Without this, an agent that crashed still "holds" its slot, so
    // every reconnect mints #2, #3, #4 -- the exact identity sprawl the
    // Profile/Session split exists to prevent.
    this.reapDeadSessions();

    const claimedProfileIds = new Set(
      [...this.sessions.values()].map((session) => session.profileId),
    );

    const forProject = this.listProfiles()
      .filter((profile) => profile.projectPath === projectPath)
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

    // An explicitly requested name wins if that exact identity is free.
    const preferred = request.preferredLabel?.trim();
    let profile =
      (preferred
        ? forProject.find((p) => p.label === preferred && !claimedProfileIds.has(p.id))
        : undefined) ?? forProject.find((p) => !claimedProfileIds.has(p.id));

    let firstSeen = false;
    if (!profile) {
      profile = await this.createProfile(projectPath, projectName, preferred, forProject.length);
      firstSeen = true;
    }

    const now = new Date().toISOString();
    const session: AgentSession = {
      sessionId: randomUUID(),
      profileId: profile.id,
      pid: request.pid,
      client: request.client,
      ...(request.clientVersion !== undefined ? { clientVersion: request.clientVersion } : {}),
      startedAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.sessionId, session);

    profile = await this.patchProfile(profile.id, { lastSeen: now });
    this.logger.info(firstSeen ? "new agent profile" : "agent reconnected", {
      label: profile.label,
      project: projectName,
      voice: `${profile.voice.providerId}/${profile.voice.voiceId}`,
    });

    return { session, profile, firstSeen };
  }

  endSession(sessionId: string): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.sessions.delete(sessionId);
    return session;
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastSeenAt = new Date().toISOString();
  }

  requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new VoiceBoxError("invalid_input", "Unknown session. Reconnect and try again.", {
        hint: "The daemon may have restarted since this agent registered.",
      });
    }
    return session;
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Forget sessions whose owning process has exited.
   *
   * Session liveness must never depend on a graceful goodbye: an MCP process
   * that is kill -9'd, crashes, or is force-quit with its editor never gets to
   * send one. Checking the pid is exact, immediate, and needs no cooperation
   * from the client.
   */
  reapDeadSessions(now = Date.now()): AgentSession[] {
    const dead = this.listSessions().filter((session) => {
      if (session.pid !== null) return !isProcessAlive(session.pid);
      // No pid to check (an unusual client): fall back to inactivity.
      return now - Date.parse(session.lastSeenAt) > PIDLESS_SESSION_TTL_MS;
    });

    for (const session of dead) this.sessions.delete(session.sessionId);
    if (dead.length > 0) {
      this.logger.debug("reaped sessions with dead processes", { count: dead.length });
    }
    return dead;
  }

  listProfiles(): AgentProfile[] {
    return Object.values(this.store.config.agents);
  }

  getProfile(profileId: string): AgentProfile | undefined {
    return this.store.config.agents[profileId];
  }

  requireProfile(profileId: string): AgentProfile {
    const profile = this.getProfile(profileId);
    if (!profile) throw new VoiceBoxError("invalid_input", `Unknown agent "${profileId}".`);
    return profile;
  }

  /** Live sessions currently bound to a profile. */
  sessionsFor(profileId: string): AgentSession[] {
    return this.listSessions().filter((session) => session.profileId === profileId);
  }

  /**
   * Rename in place. Keyed on the profile the session already holds, so calling
   * this repeatedly can never fan out into duplicate identities.
   */
  async rename(profileId: string, label: string): Promise<AgentProfile> {
    const trimmed = label.trim();
    if (!trimmed) throw new VoiceBoxError("invalid_input", "Name must not be empty.");
    return this.patchProfile(profileId, { label: trimmed });
  }

  /**
   * Change a profile's voice. Agent-initiated changes are refused once the user
   * has chosen a voice in the panel -- the human owns voice assignment.
   */
  async setVoice(
    profileId: string,
    voice: VoiceSelection,
    origin: "user" | "agent",
  ): Promise<{ profile: AgentProfile; applied: boolean }> {
    const existing = this.requireProfile(profileId);
    if (origin === "agent" && existing.voiceLockedByUser) {
      return { profile: existing, applied: false };
    }
    const provider = this.providers.require(voice.providerId);
    const validation = provider.validate(voice);
    if (!validation.ok) throw new VoiceBoxError("invalid_input", validation.reason);

    const profile = await this.patchProfile(profileId, {
      voice,
      ...(origin === "user" ? { voiceLockedByUser: true } : {}),
    });
    return { profile, applied: true };
  }

  async setMuted(profileId: string, muted: boolean): Promise<AgentProfile> {
    return this.patchProfile(profileId, { muted });
  }

  async setVolume(profileId: string, volume: number): Promise<AgentProfile> {
    return this.patchProfile(profileId, { volume: Math.min(Math.max(volume, 0), 1) });
  }

  async removeProfile(profileId: string): Promise<void> {
    await this.store.update((draft) => {
      const agents = { ...draft.agents };
      delete agents[profileId];
      return { ...draft, agents };
    });
  }

  // --- internals ----------------------------------------------------------

  private async patchProfile(
    profileId: string,
    patch: Partial<AgentProfile>,
  ): Promise<AgentProfile> {
    const current = this.requireProfile(profileId);
    const next: AgentProfile = { ...current, ...patch };
    await this.store.update((draft) => ({
      ...draft,
      agents: { ...draft.agents, [profileId]: next },
    }));
    return next;
  }

  private async createProfile(
    projectPath: string,
    projectName: string,
    preferredLabel: string | undefined,
    existingForProject: number,
  ): Promise<AgentProfile> {
    const now = new Date().toISOString();
    const label =
      preferredLabel ??
      (existingForProject === 0 ? projectName : `${projectName} #${existingForProject + 1}`);

    const profile: AgentProfile = {
      id: randomUUID(),
      label,
      projectPath,
      projectName,
      voice: await this.nextUnusedVoice(projectPath),
      voiceLockedByUser: false,
      muted: false,
      volume: 1,
      color: COLORS[this.listProfiles().length % COLORS.length] as string,
      createdAt: now,
      lastSeen: now,
    };

    await this.store.update((draft) => ({
      ...draft,
      agents: { ...draft.agents, [profile.id]: profile },
    }));
    return profile;
  }

  /**
   * Pick a voice nobody else is using, so a second agent in the same project
   * sounds different without the user configuring anything.
   */
  private async nextUnusedVoice(projectPath: string): Promise<VoiceSelection> {
    const projectDefault = this.store.config.projects[projectPath]?.defaultVoice;
    const base = this.providers.resolveVoice(projectDefault);

    const provider = this.providers.require(base.providerId);
    let catalogue: VoiceSelection[] = [];
    try {
      const voices = await provider.listVoices();
      catalogue = voices.map((voice) => ({
        providerId: voice.providerId,
        voiceId: voice.voiceId,
        ...(base.modelId !== undefined ? { modelId: base.modelId } : {}),
      }));
    } catch (error) {
      // Listing may need the network (ElevenLabs). Falling back to the default
      // voice is far better than failing to register an agent.
      this.logger.debug("voice listing failed, using default", { error });
      return base;
    }

    const taken = new Set(
      this.listProfiles().map((profile) => `${profile.voice.providerId}/${profile.voice.voiceId}`),
    );
    const free = catalogue.find((voice) => !taken.has(`${voice.providerId}/${voice.voiceId}`));
    return free ?? base;
  }
}
