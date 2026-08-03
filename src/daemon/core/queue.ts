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
  /** User-initiated replay/preview: skip history logging when it settles. */
  ephemeral?: boolean;
  /** Pre-resolved audio file (replay from cache): playback skips synthesis. */
  sourceFile?: string;
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
  /** One item promoted to play next ("play now" in the panel). */
  private frontId: string | null = null;

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

  /**
   * The pending items in the order dequeue() will actually serve them, without
   * mutating queue state. This is what the panel's #1/#2/#3 badges show --
   * insertion order lies whenever priorities or multiple agents are involved.
   *
   * Held agents' items are appended after every playable item, grouped per
   * agent in FIFO order: the panel still shows them (badged as held), but they
   * can never appear ahead of something that will actually play first.
   */
  listInPlayOrder(now = Date.now(), held?: ReadonlySet<string>): QueueItem[] {
    const remaining = this.pending.filter((item) => item.expiresAt > now || held?.has(item.profileId));
    const served = new Map(this.lastServed);
    let counter = this.serveCounter;
    const ordered: QueueItem[] = [];

    const take = (item: QueueItem) => {
      ordered.push(item);
      remaining.splice(remaining.indexOf(item), 1);
      served.set(item.profileId, ++counter);
    };

    if (this.frontId) {
      const front = remaining.find((item) => item.id === this.frontId);
      if (front) take(front);
    }
    for (;;) {
      const next = selectNext(remaining, served, now, held);
      if (!next) break;
      take(next);
    }
    // Whatever is left belongs to held agents: stable, FIFO within each agent.
    remaining.sort((a, b) =>
      a.profileId === b.profileId
        ? a.enqueuedAt - b.enqueuedAt
        : a.profileId.localeCompare(b.profileId),
    );
    return [...ordered, ...remaining];
  }

  /** Mark an item to be served before everything else. Replaces any prior mark. */
  promote(id: string): boolean {
    if (!this.pending.some((item) => item.id === id)) return false;
    this.frontId = id;
    return true;
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
  dequeue(now = Date.now(), held?: ReadonlySet<string>): QueueItem | null {
    // A promoted item beats everything -- including its agent's hold, which a
    // "play now" click plainly overrides. A held item also gets the same TTL
    // grace here that listInPlayOrder gives it: the panel showed it as
    // playable, so the click must not silently no-op on an expired-while-held
    // item. The mark is one-shot: it clears whether the item is served, was
    // removed, or expired in the meantime.
    if (this.frontId) {
      const front = this.pending.find(
        (item) =>
          item.id === this.frontId && (item.expiresAt > now || held?.has(item.profileId)),
      );
      this.frontId = null;
      if (front) {
        this.remove(front.id);
        this.lastServed.set(front.profileId, ++this.serveCounter);
        return front;
      }
    }

    const next = selectNext(this.pending, this.lastServed, now, held);
    if (!next) return null;
    this.remove(next.id);
    this.lastServed.set(next.profileId, ++this.serveCounter);
    return next;
  }

  remove(id: string): QueueItem | null {
    const index = this.pending.findIndex((item) => item.id === id);
    if (index === -1) return null;
    return this.pending.splice(index, 1)[0] ?? null;
  }

  /** Remove and return everything past its TTL. Held agents are exempt. */
  sweepExpired(now = Date.now(), held?: ReadonlySet<string>): QueueItem[] {
    const expired = this.pending.filter(
      (item) => item.expiresAt <= now && !held?.has(item.profileId),
    );
    if (expired.length > 0) {
      const ids = new Set(expired.map((item) => item.id));
      this.pending = this.pending.filter((item) => !ids.has(item.id));
    }
    return expired;
  }

  /** Push one agent's deadlines out, crediting back time spent held. */
  extendTtl(profileId: string, byMs: number): void {
    if (byMs <= 0) return;
    for (const item of this.pending) {
      if (item.profileId === profileId) item.expiresAt += byMs;
    }
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

/**
 * Pick the next item to serve: highest priority band, then least-recently-served
 * agent (round-robin fairness), then FIFO within that agent. Shared between
 * dequeue() and listInPlayOrder() so the panel can never disagree with playback.
 */
function selectNext(
  pending: readonly QueueItem[],
  lastServed: ReadonlyMap<string, number>,
  now: number,
  held?: ReadonlySet<string>,
): QueueItem | null {
  for (const band of BANDS) {
    const candidates = pending.filter(
      (item) =>
        item.priority === band && item.expiresAt > now && !held?.has(item.profileId),
    );
    if (candidates.length === 0) continue;

    // Least-recently-served agent first; ties broken by arrival order.
    let best = candidates[0] as QueueItem;
    let bestRank = lastServed.get(best.profileId) ?? -1;
    for (const candidate of candidates.slice(1)) {
      const rank = lastServed.get(candidate.profileId) ?? -1;
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
    return candidates
      .filter((item) => item.profileId === best.profileId)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0] as QueueItem;
  }
  return null;
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
