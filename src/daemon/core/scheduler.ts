import { EventEmitter } from "node:events";

import { VoiceBoxError, toVoiceBoxError, errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import type { Priority, QueueSnapshot, UserPlayback, WaitMode } from "../../shared/types.js";
import { isTerminal } from "../../shared/types.js";
import type { AudioPlayer, PlaybackHandle, PlaybackOutcome } from "../audio/index.js";
import type { ConfigStore } from "../config/store.js";
import type { HistoryEntry, HistoryLog } from "./history.js";
import { voiceLabel } from "./history.js";
import type { AgentRegistry } from "./registry.js";
import { UtteranceQueue, toUtterance, type QueueItem } from "./queue.js";
import type { Synthesizer } from "./synthesizer.js";

/**
 * Rough speaking rate, around 150 words per minute at ~5.5 characters per
 * word. Used for queue ETAs and as the base of the playback watchdog's
 * deliberately generous upper bound -- never for anything tighter.
 */
const CHARS_PER_SECOND = 14;

/** How often to reap items that went stale while sitting in the queue. */
const SWEEP_INTERVAL_MS = 5_000;

/** Bounded memory of settled items so a late waiter still gets its result. */
const SETTLED_HISTORY = 200;

export interface SpeakRequestInput {
  sessionId: string;
  text: string;
  priority?: Priority;
  wait?: WaitMode;
}

export interface SpeakOutcome {
  id: string;
  status: QueueItem["status"] | "throttled";
  queuePosition: number;
  etaSeconds: number;
  agentLabel: string;
  voiceLabel: string;
  warning?: string;
}

export interface SchedulerDeps {
  store: ConfigStore;
  registry: AgentRegistry;
  synthesizer: Synthesizer;
  player: AudioPlayer;
  history: HistoryLog;
  logger: Logger;
}

/**
 * Drives the one playback lane: dequeue, synthesize, play, settle.
 *
 * There is exactly one of these per machine because there is exactly one pair
 * of speakers; overlapping voices are unlistenable.
 */
export class Scheduler {
  private readonly queue: UtteranceQueue;
  private readonly events = new EventEmitter();
  private readonly settled = new Map<string, QueueItem>();

  private playing: QueueItem | null = null;
  /** utterance id -> cache key, so a settled item can be replayed from history. */
  private readonly audioKeys = new Map<string, string>();
  private handle: PlaybackHandle | null = null;
  private skipRequested = false;
  private paused = false;
  /** True while the current utterance is frozen mid-word (mpv IPC pause). */
  private frozen = false;
  /** True when the global pause also froze a replay/preview mid-word. */
  private userFrozen = false;
  /**
   * Agents held by a per-agent pause: their queued items stay put while other
   * agents keep playing. Value is when the hold started, so held time can be
   * credited back to TTLs on resume. Deliberately not persisted -- like
   * sessions, holds die with the daemon.
   */
  private readonly heldProfiles = new Map<string, number>();
  /** Abort for the in-flight synthesis, so skip works before audio exists. */
  private synthAbort: AbortController | null = null;
  /** The user lane: replay/preview audio playing outside the agent queue. */
  private userHandle: PlaybackHandle | null = null;
  private userPlayback: UserPlayback | null = null;
  private pumping = false;
  private stopped = false;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.queue = new UtteranceQueue(this.limits());
    this.events.setMaxListeners(200);
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.expireStale(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Mark the in-flight utterance as user-terminated so an aborted synthesis
    // settles "skipped", not a spurious "failed" in history on every restart.
    this.skipRequested = true;
    this.synthAbort?.abort();
    this.events.emit("release-hold");
    this.stopUserPlayback();
    this.handle?.stop();
    // Settle everything so wait:"played" callers resolve instead of hanging
    // and the history records what never got spoken.
    for (const item of this.queue.clear()) this.settle(item, "dropped", "daemon stopped");
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  /** Fires with the history entry each time a non-ephemeral utterance settles. */
  onHistory(listener: (entry: HistoryEntry) => void): () => void {
    this.events.on("history", listener);
    return () => this.events.off("history", listener);
  }

  // --- Public control ------------------------------------------------------

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Freeze the current utterance mid-word where the backend has a control
   * channel (mpv IPC); elsewhere the current line finishes and the pump halts
   * at the utterance boundary. Either way the queue holds until resume() and
   * agents keep enqueueing normally.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.frozen = this.handle?.pause() ?? false;
    // Freeze the user lane too: audio still sounding under a PAUSED banner
    // reads as broken. Where the backend cannot freeze, it plays out.
    this.userFrozen = this.userHandle?.pause() ?? false;
    this.emitChange();
  }

  /**
   * Return to the live queue. A replay frozen by the pause picks back up; a
   * replay started *while* paused is cut short -- resuming means "back to the
   * agents", not "talk over the memo I asked for".
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.userFrozen) {
      this.userFrozen = false;
      this.userHandle?.resume();
    } else {
      this.stopUserPlayback();
    }
    this.frozen = false;
    this.handle?.resume();
    this.events.emit("release-hold");
    this.emitChange();
    void this.pump();
  }

  /**
   * Hold one agent's queue without touching the others. The sentence being
   * spoken finishes first -- with a single playback lane, cutting it off would
   * either restart it later from scratch or silence an unrelated agent.
   */
  pauseAgent(profileId: string): void {
    if (this.heldProfiles.has(profileId)) return;
    this.heldProfiles.set(profileId, Date.now());
    this.emitChange();
  }

  resumeAgent(profileId: string): void {
    const heldAt = this.heldProfiles.get(profileId);
    if (heldAt === undefined) return;
    this.heldProfiles.delete(profileId);
    // Credit the held time back, so a long hold does not mass-expire the queue.
    this.queue.extendTtl(profileId, Date.now() - heldAt);
    this.emitChange();
    void this.pump();
  }

  /**
   * Forget a hold without the resume ceremony. Called when the agent stops
   * existing (disconnect, FORGET) -- a hold that outlives its agent would
   * exempt that agent's items from expiry forever, leaving invisible
   * immortal entries inflating every queue count.
   */
  dropHold(profileId: string): void {
    if (!this.heldProfiles.delete(profileId)) return;
    this.emitChange();
    void this.pump();
  }

  get heldProfileIds(): string[] {
    return [...this.heldProfiles.keys()];
  }

  private heldSet(): ReadonlySet<string> {
    return new Set(this.heldProfiles.keys());
  }

  skip(id?: string): boolean {
    // Skip means "skip what is sounding". When that is a replay/preview --
    // including one frozen by pause, which playItem may be blocked behind --
    // stop the user lane; the agent queue is untouched.
    if (!id && this.userHandle) {
      this.stopUserPlayback();
      this.emitChange();
      return true;
    }
    if (!id || this.playing?.id === id) {
      if (!this.playing) return false;
      this.skipRequested = true;
      // The utterance may still be synthesizing: abort that too, or the skip
      // would be swallowed and the audio would start seconds later anyway.
      this.synthAbort?.abort();
      this.events.emit("release-hold");
      this.frozen = false;
      this.handle?.stop();
      return true;
    }
    const removed = this.queue.remove(id);
    if (!removed) return false;
    this.settle(removed, "skipped");
    return true;
  }

  /** Serve a pending item before everything else in the queue. */
  playNow(id: string): boolean {
    const promoted = this.queue.promote(id);
    if (!promoted) return false;
    this.emitChange();
    void this.pump();
    return true;
  }

  clear(profileId?: string): number {
    const removed = this.queue.clear(profileId);
    for (const item of removed) this.settle(item, "skipped");
    return removed.length;
  }

  /**
   * The user lane: play a replayed memo or a voice preview.
   *
   * Plays immediately when nothing is audibly speaking -- including while
   * paused, which is the whole point: pause the queue, go back and listen to
   * an older memo, then resume and the live flow continues. When an agent IS
   * mid-sentence, the audio slots in directly after it instead of overlapping.
   */
  async playUserAudio(input: {
    label: string;
    text: string;
    file: string;
    volume: number;
  }): Promise<"playing" | "queued"> {
    const audiblyBusy = this.playing !== null && this.playing.status === "playing" && !this.frozen;

    if (!audiblyBusy) {
      this.stopUserPlayback();
      this.userPlayback = {
        label: input.label,
        text: input.text,
        startedAt: new Date().toISOString(),
      };
      const handle = this.deps.player.play(input.file, { volume: input.volume });
      this.userHandle = handle;
      this.emitChange();
      void handle.done.then(() => {
        if (this.userHandle === handle) {
          this.userHandle = null;
          this.userPlayback = null;
          this.userFrozen = false;
          this.emitChange();
        }
      });
      return "playing";
    }

    // Mid-sentence: front-of-queue ephemeral item, played right after the
    // current line through the one lane. Never overlaps.
    this.queue.updateLimits(this.limits());
    const result = this.queue.enqueue({
      profileId: "user",
      agentLabel: input.label,
      text: input.text,
      priority: "urgent",
      voice: { providerId: "openai", voiceId: "user-audio" },
      volume: input.volume,
      ttlMs: 120_000,
    });
    if (!result.ok) {
      throw new VoiceBoxError("invalid_input", "The queue is full; try again in a moment.", {
        retryable: true,
      });
    }
    result.item.ephemeral = true;
    result.item.sourceFile = input.file;
    this.queue.promote(result.item.id);
    this.emitChange();
    void this.pump();
    return "queued";
  }

  /** Drop an agent's low-value backlog when its MCP process disconnects. */
  onSessionEnd(profileId: string): void {
    // Holds die with the agent, like sessions do.
    this.dropHold(profileId);
    if (!this.deps.store.config.queue.purgeOnDisconnect) return;
    const purged = this.queue.purgeForSession(profileId);
    for (const item of purged) this.settle(item, "dropped", "agent disconnected");
    if (purged.length > 0) {
      this.deps.logger.debug("purged backlog for disconnected agent", { count: purged.length });
    }
  }

  snapshot(): QueueSnapshot {
    return {
      playing: this.playing ? toUtterance(this.playing) : null,
      pending: this.queue.listInPlayOrder(Date.now(), this.heldSet()).map(toUtterance),
      paused: this.paused,
      frozenMidUtterance: this.frozen,
      pausedProfiles: this.heldProfileIds,
      userPlayback: this.userPlayback,
    };
  }

  /**
   * Push volume changes into audio that is already playing, where the backend
   * can. Called when a per-agent or master volume slider moves, so the change
   * is audible immediately instead of from the next utterance.
   */
  applyLiveVolume(): void {
    const item = this.playing;
    if (!item || !this.handle?.setVolume) return;
    const master = item.ephemeral ? 1 : this.deps.store.config.audio.volume;
    const agentVolume = item.ephemeral
      ? item.volume
      : (this.deps.registry.getProfile(item.profileId)?.volume ?? item.volume);
    this.handle.setVolume(agentVolume * master);
  }

  // --- Enqueue -------------------------------------------------------------

  async speak(request: SpeakRequestInput): Promise<SpeakOutcome> {
    const session = this.deps.registry.requireSession(request.sessionId);
    this.deps.registry.touch(request.sessionId);
    const profile = this.deps.registry.requireProfile(session.profileId);

    const text = request.text.trim();
    if (!text) throw new VoiceBoxError("invalid_input", "There is no text to speak.");

    const config = this.deps.store.config;
    const priority = request.priority ?? config.queue.defaultPriority;
    const wait = request.wait ?? config.queue.defaultWait;
    const voiceLabel = `${profile.voice.providerId}/${profile.voice.voiceId}`;

    // Muting is enforced here, before any provider call, so silencing a noisy
    // agent actually stops spending money rather than just hiding the audio.
    if (profile.muted) {
      return {
        id: "",
        status: "muted",
        queuePosition: 0,
        etaSeconds: 0,
        agentLabel: profile.label,
        voiceLabel,
      };
    }

    // Fail fast if nothing can synthesize, rather than queueing an utterance
    // that is guaranteed to fail later.
    const provider = this.deps.synthesizer.providerFor(profile.voice);
    if (!provider.isConfigured()) throw this.deps.synthesizer.notConfiguredError();

    this.queue.updateLimits(this.limits());
    const result = this.queue.enqueue({
      profileId: profile.id,
      agentLabel: profile.label,
      text,
      priority,
      voice: profile.voice,
      volume: profile.volume,
      ttlMs: config.queue.ttlSeconds[priority] * 1000,
    });

    if (!result.ok) {
      throw new VoiceBoxError(
        "invalid_input",
        `The speech queue is full (${result.scope}). Try again shortly.`,
        { retryable: true },
      );
    }

    if (result.evicted) {
      this.settle(result.evicted, "dropped", "superseded by a newer message");
      this.deps.logger.debug("dropped oldest to make room", { agent: profile.label });
    }

    this.emitChange();
    void this.pump();

    const position = this.positionOf(result.item.id);
    const outcome: SpeakOutcome = {
      id: result.item.id,
      status: "queued",
      queuePosition: position,
      etaSeconds: this.estimateEta(result.item.id),
      agentLabel: profile.label,
      voiceLabel,
    };

    if (wait === "none") return outcome;

    // A held agent's items settle only when the user resumes it -- waiting on
    // that would hang this tool call for its full deadline and backpressure
    // would never relieve. Return truthfully instead.
    if (this.heldProfiles.has(profile.id)) {
      return {
        ...outcome,
        warning: "This agent is paused in the control panel; the message plays after it is resumed.",
      };
    }

    if (wait === "played") {
      const finished = await this.waitForTerminal(result.item.id);
      if (!finished) {
        // Deadline hit -- still queued, paused, or mid-playback. Report the
        // truthful in-flight state instead of letting the socket die.
        return {
          ...outcome,
          status: this.playing?.id === result.item.id ? this.playing.status : "queued",
          queuePosition: this.positionOf(result.item.id),
          etaSeconds: this.estimateEta(result.item.id),
          warning: "Still waiting for its turn; playback continues in the background.",
        };
      }
      return {
        ...outcome,
        status: finished.status,
        queuePosition: 0,
        etaSeconds: 0,
        ...(finished.detail !== undefined ? { warning: finished.detail } : {}),
      };
    }

    // "accepted": return at once unless this agent is already running ahead of
    // the speaker, in which case hold briefly. Backpressure is measured per
    // agent, never globally, so agent B is never blocked by agent A.
    const threshold = config.queue.backpressureThreshold;
    if (this.queue.depthFor(profile.id) > threshold) {
      const relieved = await this.waitForCapacity(
        profile.id,
        threshold,
        config.queue.backpressureTimeoutMs,
      );
      if (!relieved) return { ...outcome, status: "throttled" };
    }
    return outcome;
  }

  // --- Pump ----------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.paused && !this.stopped) {
        // The user lane owns the speakers while a replay/preview is sounding.
        if (this.userHandle) {
          await this.userHandle.done;
          continue;
        }
        this.expireStale();
        const item = this.queue.dequeue(Date.now(), this.heldSet());
        if (!item) break;
        await this.playItem(item);
      }
    } catch (error) {
      this.deps.logger.error("scheduler pump failed", { error: errorMessage(error) });
    } finally {
      this.pumping = false;
    }
  }

  private async playItem(item: QueueItem): Promise<void> {
    // Re-check: the agent may have been muted after this was queued.
    // (User-lane items have no profile and play as-is.)
    const profile = this.deps.registry.getProfile(item.profileId);
    if (!item.ephemeral && (!profile || profile.muted)) {
      this.settle(item, "muted");
      return;
    }

    this.playing = item;
    this.skipRequested = false;
    item.startedAt = Date.now();

    let file: string;
    if (item.sourceFile !== undefined) {
      // Replay/preview audio was already resolved -- nothing to synthesize.
      file = item.sourceFile;
    } else {
      item.status = "synthesizing";
      this.emitChange();

      this.synthAbort = new AbortController();
      try {
        const audio = await this.synthesizeWithRetry(item, this.synthAbort.signal);
        file = audio.file;
        this.audioKeys.set(item.id, audio.key);
      } catch (error) {
        this.playing = null;
        if (this.skipRequested) {
          this.settle(item, "skipped");
          return;
        }
        const mapped = toVoiceBoxError(error);
        this.deps.logger.warn("synthesis failed", { code: mapped.code, message: mapped.message });
        this.settle(item, "failed", mapped.message);
        return;
      } finally {
        this.synthAbort = null;
      }
    }

    // A replay/preview may have grabbed the speakers while we were
    // synthesizing (there was nothing audible to block it then). Let it finish
    // before starting this line -- overlapping voices is the cardinal sin.
    while (this.userHandle) {
      await this.userHandle.done;
    }

    // A pause can land while we are synthesizing. There is no audio to freeze
    // yet, and starting a new line while paused would be plainly wrong, so hold
    // the fully-prepared utterance until resume (or skip).
    if (this.paused) {
      const released = await this.holdWhilePaused();
      if (!released || this.skipRequested || this.stopped) {
        this.playing = null;
        this.settle(item, "skipped");
        return;
      }
    }

    // A skip during synthesis has no handle to stop and (on a cache hit) no
    // request to abort -- catch it here so the audio never starts.
    if (this.skipRequested || this.stopped) {
      this.playing = null;
      this.settle(item, "skipped");
      return;
    }

    item.status = "playing";
    this.emitChange();

    // Volume is read here, at play time, not from the enqueue-time snapshot:
    // moving an agent's slider must affect everything that has not sounded
    // yet. User-lane volume arrives pre-multiplied by the routes; agent items
    // get profile x master applied here.
    const master = item.ephemeral ? 1 : this.deps.store.config.audio.volume;
    const agentVolume = item.ephemeral ? item.volume : (profile?.volume ?? item.volume);
    this.handle = this.deps.player.play(file, { volume: agentVolume * master });
    const outcome = await this.watchPlayback(this.handle, item);
    this.handle = null;
    this.frozen = false;
    this.playing = null;

    switch (outcome.status) {
      case "completed":
        this.settle(item, "played");
        break;
      case "stopped":
        this.settle(item, this.skipRequested ? "skipped" : "dropped");
        break;
      case "degraded":
        this.settle(item, "degraded", outcome.reason);
        break;
      case "failed":
        this.settle(item, "failed", outcome.error.message);
        break;
    }
  }

  /**
   * Wait for playback to end, with a watchdog. A player process that hangs
   * (afplay wedged by a CoreAudio hiccup, a stalled pipe) used to block the
   * one playback lane forever -- nothing would speak again until a restart.
   * Time spent paused does not count against the limit.
   */
  private watchPlayback(handle: PlaybackHandle, item: QueueItem): Promise<PlaybackOutcome> {
    // Generous on purpose: the duration is a chars-per-second guess, and a
    // slow voice must never be truncated mid-sentence and logged as failed.
    // This only needs to catch the pathological case (a wedged process).
    const limitMs = Math.max(120_000, this.durationOf(item) * 4 * 1000 + 30_000);
    return new Promise((resolve) => {
      let unpausedMs = 0;
      let last = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        if (!this.paused && !handle.paused) unpausedMs += now - last;
        last = now;
        if (unpausedMs >= limitMs) {
          clearInterval(timer);
          this.deps.logger.warn("playback watchdog fired -- recovering the lane", {
            id: item.id,
            agent: item.agentLabel,
          });
          handle.stop();
          resolve({
            status: "failed",
            error: new VoiceBoxError(
              "playback_failed",
              "The audio player stopped responding; playback was recovered.",
            ),
          });
        }
      }, 1_000);
      timer.unref();
      void handle.done.then((outcome) => {
        clearInterval(timer);
        resolve(outcome);
      });
    });
  }

  private async synthesizeWithRetry(item: QueueItem, signal: AbortSignal) {
    try {
      return await this.deps.synthesizer.synthesize(item.text, item.voice, signal);
    } catch (error) {
      const mapped = toVoiceBoxError(error);
      if (signal.aborted || !mapped.retryable) throw mapped;

      // One retry, honouring Retry-After when the provider supplied it.
      const delayMs = (mapped.retryAfterSeconds ?? 1) * 1000 + Math.floor(Math.random() * 250);
      this.deps.logger.debug("retrying synthesis", { code: mapped.code, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await this.deps.synthesizer.synthesize(item.text, item.voice, signal);
    }
  }

  /** Resolves true when resume() releases the hold, false on skip/stop. */
  private holdWhilePaused(): Promise<boolean> {
    if (!this.paused) return Promise.resolve(true);
    if (this.skipRequested || this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.events.once("release-hold", () => resolve(!this.skipRequested && !this.stopped));
    });
  }

  private stopUserPlayback(): void {
    this.userFrozen = false;
    if (!this.userHandle) return;
    const handle = this.userHandle;
    this.userHandle = null;
    this.userPlayback = null;
    handle.stop();
  }

  // --- Helpers -------------------------------------------------------------

  private limits() {
    const queue = this.deps.store.config.queue;
    return {
      maxDepth: queue.maxDepth,
      maxPerAgent: queue.maxPerAgent,
      overflow: queue.overflow,
    };
  }

  private expireStale(): void {
    // Held agents are exempt: their items are waiting on the user, not stale.
    const expired = this.queue.sweepExpired(Date.now(), this.heldSet());
    if (expired.length === 0) return;
    for (const item of expired) {
      this.settle(item, "expired", "too old to still be useful");
    }
    this.deps.logger.debug("expired stale utterances", { count: expired.length });
  }

  private settle(item: QueueItem, status: QueueItem["status"], detail?: string): void {
    item.status = status;
    item.finishedAt = Date.now();
    if (detail !== undefined) item.detail = detail;

    this.settled.set(item.id, item);
    if (this.settled.size > SETTLED_HISTORY) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }

    const audioKey = this.audioKeys.get(item.id);
    this.audioKeys.delete(item.id);
    // Replays and previews are not logged: the original entry already records
    // what was said, and duplicates would clutter every agent's backlog.
    if (!item.ephemeral) {
      const entry: HistoryEntry = {
        id: item.id,
        at: new Date(item.finishedAt).toISOString(),
        profileId: item.profileId,
        agentLabel: item.agentLabel,
        text: item.text,
        voice: voiceLabel(item.voice),
        status,
        ...(audioKey !== undefined ? { audioKey } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
      this.deps.history.append(entry);
      this.events.emit("history", entry);
    }

    this.events.emit(`settled:${item.id}`, item);
    this.events.emit("capacity", item.profileId);
    this.emitChange();
  }

  private emitChange(): void {
    this.events.emit("change");
  }

  private positionOf(id: string): number {
    const index = this.queue
      .listInPlayOrder(Date.now(), this.heldSet())
      .findIndex((item) => item.id === id);
    return index === -1 ? 0 : index + 1;
  }

  private estimateEta(id: string): number {
    let seconds = this.playing ? this.durationOf(this.playing) / 2 : 0;
    for (const item of this.queue.listInPlayOrder(Date.now(), this.heldSet())) {
      if (item.id === id) break;
      seconds += this.durationOf(item);
    }
    return Math.round(seconds);
  }

  private durationOf(item: QueueItem): number {
    return item.text.length / CHARS_PER_SECOND;
  }

  /**
   * Wait for the utterance to reach a terminal state, or null on deadline.
   * The deadline sits below the HTTP request timeout: without it, a long queue
   * (or a pause) kills the socket and the client misdiagnoses a dead daemon.
   */
  private waitForTerminal(id: string, deadlineMs = 25_000): Promise<QueueItem | null> {
    const already = this.settled.get(id);
    if (already && isTerminal(already.status)) return Promise.resolve(already);

    return new Promise((resolve) => {
      const event = `settled:${id}`;
      const timer = setTimeout(() => {
        this.events.off(event, onSettle);
        resolve(null);
      }, deadlineMs);
      timer.unref();
      const onSettle = (item: QueueItem) => {
        clearTimeout(timer);
        resolve(item);
      };
      this.events.once(event, onSettle);
    });
  }

  private waitForCapacity(
    profileId: string,
    threshold: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.queue.depthFor(profileId) <= threshold) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.events.off("capacity", onCapacity);
        resolve(false);
      }, timeoutMs);
      timer.unref();

      const onCapacity = (changed: string) => {
        if (changed !== profileId) return;
        if (this.queue.depthFor(profileId) > threshold) return;
        clearTimeout(timer);
        this.events.off("capacity", onCapacity);
        resolve(true);
      };
      this.events.on("capacity", onCapacity);
    });
  }
}
