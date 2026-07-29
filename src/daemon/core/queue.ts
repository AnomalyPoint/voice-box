import { randomUUID } from "node:crypto";

import type {
  Priority,
  Utterance,
  UtteranceStatus,
  VoiceSelection,
} from "../../shared/types.js";
import { PRIORITIES } from "../../shared/types.js";

/** Internal item: numeric timestamps, mapped to ISO strings at the boundary. */
export interface QueueItem {
  id: string;
  profileId: string;
  agentLabel: string;
  text: string;
  priority: Priority;
  status: UtteranceStatus;
  voice: VoiceSelection;
  volume: number;
  enqueuedAt: number;
  expiresAt: number;
  startedAt?: number;
  finishedAt?: number;
  detail?: string;
}

export interface EnqueueInput {
  profileId: string;
  agentLabel: string;
  text: string;
  priority: Priority;
  voice: VoiceSelection;
  volume: number;
  ttlMs: number;
}

export type OverflowPolicy = "dropOldestFromSameAgent" | "reject";

export interface QueueLimits {
  maxDepth: number;
  maxPerAgent: number;
  overflow: OverflowPolicy;
}

export type EnqueueResult =
  | { ok: true; item: QueueItem; evicted: QueueItem | null }
  | { ok: false; reason: "full"; scope: "global" | "agent" };

/** Descending priority, so index 0 is the most urgent band. */
const BANDS: readonly Priority[] = [...PRIORITIES].reverse();

/**
 * Pending utterances for the single playback lane.
 *
 * Ordering is by priority band, then weighted round-robin across agents, then
 * FIFO within an agent. Strict global FIFO was rejected: it lets one chatty
 * agent hold the speaker while another waits, which is precisely the failure
 * this rewrite exists to fix.
 */
export class UtteranceQueue {
  private pending: QueueItem[] = [];
  /** Monotonic service counter per agent, used for round-robin fairness. */
  private readonly lastServed = new Map<string, number>();
  private serveCounter = 0;

  constructor(private limits: QueueLimits) {}

  updateLimits(limits: QueueLimits): void {
    this.limits = limits;
  }

  get depth(): number {
    return this.pending.length;
  }

  depthFor(profileId: string): number {
    return this.pending.reduce((count, item) => (item.profileId === profileId ? count + 1 : count), 0);
  }

  list(): QueueItem[] {
    return [...this.pending];
  }

  find(id: string): QueueItem | undefined {
    return this.pending.find((item) => item.id === id);
  }

  enqueue(input: EnqueueInput, now = Date.now()): EnqueueResult {
    const item: QueueItem = {
      id: randomUUID(),
      profileId: input.profileId,
      agentLabel: input.agentLabel,
      text: input.text,
      priority: input.priority,
      status: "queued",
      voice: input.voice,
      volume: input.volume,
      enqueuedAt: now,
      expiresAt: now + input.ttlMs,
    };

    let evicted: QueueItem | null = null;

    const agentDepth = this.depthFor(input.profileId);
    if (agentDepth >= this.limits.maxPerAgent) {
      if (this.limits.overflow === "reject") return { ok: false, reason: "full", scope: "agent" };
      // Newest narration is the most relevant, so drop this agent's oldest.
      evicted = this.dropOldestFor(input.profileId);
      if (!evicted) return { ok: false, reason: "full", scope: "agent" };
    } else if (this.pending.length >= this.limits.maxDepth) {
      if (this.limits.overflow === "reject") return { ok: false, reason: "full", scope: "global" };
      evicted = this.dropOldestFor(input.profileId) ?? this.dropGlobalOldest();
      if (!evicted) return { ok: false, reason: "full", scope: "global" };
    }

    this.pending.push(item);
    return { ok: true, item, evicted };
  }

  /**
   * Pop the next item to speak, honouring bands and round-robin fairness.
   * Expired items are never returned -- callers should sweep first, but this
   * double-checks because expiry is time-based and the sweep is periodic.
   */
  dequeue(now = Date.now()): QueueItem | null {
    for (const band of BANDS) {
      const candidates = this.pending.filter(
        (item) => item.priority === band && item.expiresAt > now,
      );
      if (candidates.length === 0) continue;

      // Least-recently-served agent first; ties broken by arrival order.
      let best = candidates[0] as QueueItem;
      let bestRank = this.lastServed.get(best.profileId) ?? -1;
      for (const candidate of candidates.slice(1)) {
        const rank = this.lastServed.get(candidate.profileId) ?? -1;
        if (rank < bestRank) {
          best = candidate;
          bestRank = rank;
          continue;
        }
        if (rank === bestRank && candidate.enqueuedAt < best.enqueuedAt) {
          best = candidate;
        }
      }

      // Within one agent, order is always strict FIFO.
      const earliestForAgent = candidates
        .filter((item) => item.profileId === best.profileId)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0] as QueueItem;

      this.remove(earliestForAgent.id);
      this.lastServed.set(earliestForAgent.profileId, ++this.serveCounter);
      return earliestForAgent;
    }
    return null;
  }

  remove(id: string): QueueItem | null {
    const index = this.pending.findIndex((item) => item.id === id);
    if (index === -1) return null;
    return this.pending.splice(index, 1)[0] ?? null;
  }

  /** Remove and return everything past its TTL. */
  sweepExpired(now = Date.now()): QueueItem[] {
    const expired = this.pending.filter((item) => item.expiresAt <= now);
    if (expired.length > 0) {
      const ids = new Set(expired.map((item) => item.id));
      this.pending = this.pending.filter((item) => !ids.has(item.id));
    }
    return expired;
  }

  clear(profileId?: string): QueueItem[] {
    const removed = profileId
      ? this.pending.filter((item) => item.profileId === profileId)
      : [...this.pending];
    const ids = new Set(removed.map((item) => item.id));
    this.pending = this.pending.filter((item) => !ids.has(item.id));
    return removed;
  }

  /**
   * Drop an agent's low-value backlog when its session goes away, keeping
   * anything it flagged as important.
   */
  purgeForSession(profileId: string): QueueItem[] {
    const removed = this.pending.filter(
      (item) => item.profileId === profileId && (item.priority === "low" || item.priority === "normal"),
    );
    const ids = new Set(removed.map((item) => item.id));
    this.pending = this.pending.filter((item) => !ids.has(item.id));
    return removed;
  }

  private dropOldestFor(profileId: string): QueueItem | null {
    const oldest = this.pending
      .filter((item) => item.profileId === profileId)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
    return oldest ? this.remove(oldest.id) : null;
  }

  private dropGlobalOldest(): QueueItem | null {
    const oldest = [...this.pending].sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
    return oldest ? this.remove(oldest.id) : null;
  }
}

export function toUtterance(item: QueueItem): Utterance {
  return {
    id: item.id,
    profileId: item.profileId,
    agentLabel: item.agentLabel,
    text: item.text,
    priority: item.priority,
    status: item.status,
    voice: item.voice,
    enqueuedAt: new Date(item.enqueuedAt).toISOString(),
    expiresAt: new Date(item.expiresAt).toISOString(),
    ...(item.startedAt !== undefined ? { startedAt: new Date(item.startedAt).toISOString() } : {}),
    ...(item.finishedAt !== undefined
      ? { finishedAt: new Date(item.finishedAt).toISOString() }
      : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
  };
}
