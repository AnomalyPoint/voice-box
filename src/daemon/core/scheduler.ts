import { EventEmitter } from "node:events";

import { VoiceBoxError, toVoiceBoxError, errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import type { Priority, QueueSnapshot, WaitMode } from "../../shared/types.js";
import { isTerminal } from "../../shared/types.js";
import type { AudioPlayer, PlaybackHandle } from "../audio/index.js";
import type { ConfigStore } from "../config/store.js";
import type { HistoryLog } from "./history.js";
import { voiceLabel } from "./history.js";
import type { AgentRegistry } from "./registry.js";
import { UtteranceQueue, toUtterance, type QueueItem } from "./queue.js";
import type { Synthesizer } from "./synthesizer.js";

/**
 * Rough speaking rate used only for queue ETAs. Around 150 words per minute at
 * ~5.5 characters per word. Never used for control flow -- only display.
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
    this.handle?.stop();
    this.queue.clear();
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  // --- Public control ------------------------------------------------------

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Pause at the utterance boundary by default: the current line finishes and
   * the pump halts. Cutting mid-sentence sounds broken, and SIGSTOP has no
   * Windows equivalent, so boundary gating is both nicer and portable.
   */
  pause(): void {
    this.paused = true;
    this.emitChange();
  }

  resume(): void {
    this.paused = false;
    this.emitChange();
    void this.pump();
  }

  skip(id?: string): boolean {
    if (!id || this.playing?.id === id) {
      if (!this.playing) return false;
      this.skipRequested = true;
      this.handle?.stop();
      return true;
    }
    const removed = this.queue.remove(id);
    if (!removed) return false;
    this.settle(removed, "skipped");
    return true;
  }

  clear(profileId?: string): number {
    const removed = this.queue.clear(profileId);
    for (const item of removed) this.settle(item, "skipped");
    return removed.length;
  }

  /** Drop an agent's low-value backlog when its MCP process disconnects. */
  onSessionEnd(profileId: string): void {
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
      pending: this.queue.list().map(toUtterance),
      paused: this.paused,
    };
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
    this.deps.registry.requireProfile(profile.id);
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

    if (wait === "played") {
      const finished = await this.waitForTerminal(result.item.id);
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
        this.expireStale();
        const item = this.queue.dequeue();
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
    const profile = this.deps.registry.getProfile(item.profileId);
    if (!profile || profile.muted) {
      this.settle(item, "muted");
      return;
    }

    this.playing = item;
    item.status = "synthesizing";
    item.startedAt = Date.now();
    this.emitChange();

    let file: string;
    try {
      const audio = await this.synthesizeWithRetry(item);
      file = audio.file;
      this.audioKeys.set(item.id, audio.key);
    } catch (error) {
      const mapped = toVoiceBoxError(error);
      this.deps.logger.warn("synthesis failed", { code: mapped.code, message: mapped.message });
      this.playing = null;
      this.settle(item, "failed", mapped.message);
      return;
    }

    item.status = "playing";
    this.emitChange();

    this.skipRequested = false;
    this.handle = this.deps.player.play(file, { volume: item.volume });
    const outcome = await this.handle.done;
    this.handle = null;
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

  private async synthesizeWithRetry(item: QueueItem) {
    try {
      return await this.deps.synthesizer.synthesize(item.text, item.voice);
    } catch (error) {
      const mapped = toVoiceBoxError(error);
      if (!mapped.retryable) throw mapped;

      // One retry, honouring Retry-After when the provider supplied it.
      const delayMs = (mapped.retryAfterSeconds ?? 1) * 1000 + Math.floor(Math.random() * 250);
      this.deps.logger.debug("retrying synthesis", { code: mapped.code, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await this.deps.synthesizer.synthesize(item.text, item.voice);
    }
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
    const expired = this.queue.sweepExpired();
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
    this.deps.history.append({
      id: item.id,
      at: new Date(item.finishedAt).toISOString(),
      profileId: item.profileId,
      agentLabel: item.agentLabel,
      text: item.text,
      voice: voiceLabel(item.voice),
      status,
      ...(audioKey !== undefined ? { audioKey } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });

    this.events.emit(`settled:${item.id}`, item);
    this.events.emit("capacity", item.profileId);
    this.emitChange();
  }

  private emitChange(): void {
    this.events.emit("change");
  }

  private positionOf(id: string): number {
    const index = this.queue.list().findIndex((item) => item.id === id);
    return index === -1 ? 0 : index + 1;
  }

  private estimateEta(id: string): number {
    let seconds = this.playing ? this.durationOf(this.playing) / 2 : 0;
    for (const item of this.queue.list()) {
      if (item.id === id) break;
      seconds += this.durationOf(item);
    }
    return Math.round(seconds);
  }

  private durationOf(item: QueueItem): number {
    return item.text.length / CHARS_PER_SECOND;
  }

  private waitForTerminal(id: string): Promise<QueueItem> {
    const already = this.settled.get(id);
    if (already && isTerminal(already.status)) return Promise.resolve(already);

    return new Promise((resolve) => {
      this.events.once(`settled:${id}`, (item: QueueItem) => resolve(item));
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
