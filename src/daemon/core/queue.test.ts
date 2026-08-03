import { test } from "node:test";
import assert from "node:assert/strict";

import type { VoiceSelection } from "../../shared/types.js";
import { UtteranceQueue, type EnqueueInput } from "./queue.js";

const VOICE: VoiceSelection = { providerId: "openai", voiceId: "nova", modelId: "tts-1" };

/**
 * Fixed fake clock. Enqueue times and drain times must share one time base --
 * enqueueing at t=1000 and draining at Date.now() makes every item look
 * expired, which silently turns these assertions into no-ops.
 */
const T0 = 1_000_000;

const limits = (over: Partial<ConstructorParameters<typeof UtteranceQueue>[0]> = {}) => ({
  maxDepth: 50,
  maxPerAgent: 8,
  overflow: "dropOldestFromSameAgent" as const,
  ...over,
});

function input(profileId: string, text: string, over: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    profileId,
    agentLabel: profileId,
    text,
    priority: "normal",
    voice: VOICE,
    volume: 1,
    ttlMs: 120_000,
    ...over,
  };
}

/** Enqueue then drain, returning the order items came out in. */
function drain(queue: UtteranceQueue, now = T0 + 10): string[] {
  const order: string[] = [];
  for (;;) {
    const item = queue.dequeue(now);
    if (!item) break;
    order.push(`${item.profileId}:${item.text}`);
  }
  return order;
}

test("one chatty agent cannot monopolise the speaker", () => {
  const queue = new UtteranceQueue(limits());
  // A queues five in a row before B says anything.
  for (let i = 1; i <= 5; i++) queue.enqueue(input("A", `a${i}`), T0 + 1000 + i);
  queue.enqueue(input("B", "b1"), T0 + 2000);

  const order = drain(queue);
  const bIndex = order.indexOf("B:b1");
  assert.equal(order.length, 6, "every queued utterance must come back out");
  assert.ok(bIndex !== -1, "B must actually be served");
  // B must not wait behind all five of A's lines.
  assert.ok(bIndex <= 1, `B should be served early, got order ${order.join(", ")}`);
});

test("within one agent, order is strictly FIFO", () => {
  const queue = new UtteranceQueue(limits());
  for (let i = 1; i <= 4; i++) queue.enqueue(input("A", `a${i}`), T0 + 1000 + i);

  const order = drain(queue).map((entry) => entry.replace("A:", ""));
  assert.deepEqual(order, ["a1", "a2", "a3", "a4"]);
});

test("higher priority bands are served first", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "normal"), T0 + 1000);
  queue.enqueue(input("B", "urgent", { priority: "urgent" }), T0 + 1001);
  queue.enqueue(input("C", "low", { priority: "low" }), T0 + 1002);

  const order = drain(queue);
  assert.equal(order[0], "B:urgent");
  assert.equal(order[order.length - 1], "C:low");
});

test("expired items are never dequeued", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "stale", { ttlMs: 100 }), T0 + 1000);
  queue.enqueue(input("A", "fresh", { ttlMs: 100_000 }), T0 + 1000);

  // 5 seconds later the first is well past its 100ms TTL.
  const order = drain(queue, T0 + 6000);
  assert.deepEqual(order, ["A:fresh"], "a stale utterance must not be spoken late");
});

test("sweepExpired removes exactly the stale entries", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "stale", { ttlMs: 50 }), T0 + 1000);
  queue.enqueue(input("A", "fresh", { ttlMs: 999_000 }), T0 + 1000);

  const expired = queue.sweepExpired(T0 + 5000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.text, "stale");
  assert.equal(queue.depth, 1);
});

test("per-agent overflow drops that agent's oldest, not another agent's work", () => {
  const queue = new UtteranceQueue(limits({ maxPerAgent: 3 }));
  queue.enqueue(input("B", "b-keep"), T0 + 500);
  for (let i = 1; i <= 3; i++) queue.enqueue(input("A", `a${i}`), T0 + 1000 + i);

  const result = queue.enqueue(input("A", "a4"), T0 + 2000);
  assert.ok(result.ok);
  assert.equal(result.evicted?.text, "a1", "oldest from the same agent should go");

  const remaining = drain(queue);
  assert.ok(remaining.includes("B:b-keep"), "another agent's message must survive");
  assert.ok(!remaining.includes("A:a1"));
});

test("reject overflow policy refuses instead of evicting", () => {
  const queue = new UtteranceQueue(limits({ maxPerAgent: 2, overflow: "reject" }));
  queue.enqueue(input("A", "a1"), T0 + 1000);
  queue.enqueue(input("A", "a2"), T0 + 1001);

  const result = queue.enqueue(input("A", "a3"), T0 + 1002);
  assert.equal(result.ok, false);
  assert.equal(queue.depth, 2, "nothing may be silently dropped under reject");
});

test("depthFor counts only the given agent", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "a1"), T0 + 1000);
  queue.enqueue(input("A", "a2"), T0 + 1001);
  queue.enqueue(input("B", "b1"), T0 + 1002);

  assert.equal(queue.depthFor("A"), 2);
  assert.equal(queue.depthFor("B"), 1);
  assert.equal(queue.depth, 3);
});

test("disconnect purges routine chatter but keeps urgent messages", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "chatter"), T0 + 1000);
  queue.enqueue(input("A", "low", { priority: "low" }), T0 + 1001);
  queue.enqueue(input("A", "important", { priority: "urgent" }), T0 + 1002);
  queue.enqueue(input("B", "other"), T0 + 1003);

  const purged = queue.purgeForSession("A");
  assert.equal(purged.length, 2);

  const remaining = drain(queue);
  assert.ok(remaining.includes("A:important"), "urgent must survive a disconnect");
  assert.ok(remaining.includes("B:other"), "other agents are untouched");
});

test("clear can target a single agent", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "a1"), T0 + 1000);
  queue.enqueue(input("B", "b1"), T0 + 1001);

  assert.equal(queue.clear("A").length, 1);
  assert.deepEqual(drain(queue), ["B:b1"]);
});

test("listInPlayOrder matches what dequeue actually serves", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "a1"), T0 + 1000);
  queue.enqueue(input("A", "a2"), T0 + 1001);
  queue.enqueue(input("B", "b1", { priority: "high" }), T0 + 1002);
  queue.enqueue(input("C", "c1"), T0 + 1003);
  queue.enqueue(input("B", "b2"), T0 + 1004);

  const predicted = queue
    .listInPlayOrder(T0 + 10)
    .map((item) => `${item.profileId}:${item.text}`);
  const actual = drain(queue);
  assert.deepEqual(predicted, actual, "the panel's order badges must never lie");
});

test("listInPlayOrder does not mutate the queue", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "a1"), T0 + 1000);
  queue.enqueue(input("B", "b1"), T0 + 1001);

  const first = queue.listInPlayOrder(T0 + 10).map((item) => item.id);
  const second = queue.listInPlayOrder(T0 + 10).map((item) => item.id);
  assert.deepEqual(first, second);
  assert.equal(queue.depth, 2);
});

test("a promoted item is served before everything, including urgent", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "urgent", { priority: "urgent" }), T0 + 1000);
  const target = queue.enqueue(input("B", "promoted", { priority: "low" }), T0 + 1001);
  assert.ok(target.ok);

  assert.ok(queue.promote(target.item.id));
  const predicted = queue.listInPlayOrder(T0 + 10).map((item) => item.text);
  assert.equal(predicted[0], "promoted");

  const order = drain(queue);
  assert.equal(order[0], "B:promoted");
  assert.equal(order[1], "A:urgent");
});

test("promote is one-shot and survives a removed target", () => {
  const queue = new UtteranceQueue(limits());
  const target = queue.enqueue(input("A", "a1"), T0 + 1000);
  queue.enqueue(input("B", "b1"), T0 + 1001);
  assert.ok(target.ok);

  queue.promote(target.item.id);
  queue.remove(target.item.id);
  // The mark points at a gone item; dequeue must fall through cleanly.
  assert.equal(queue.dequeue(T0 + 10)?.text, "b1");
  assert.equal(queue.promote("nonexistent"), false);
});

test("round-robin keeps rotating across three agents", () => {
  const queue = new UtteranceQueue(limits());
  for (const agent of ["A", "B", "C"]) {
    for (let i = 1; i <= 3; i++) queue.enqueue(input(agent, `${agent}${i}`), T0 + 1000 + i);
  }

  const order = drain(queue).map((entry) => entry.split(":")[0]);
  // Each rotation of three should contain each agent exactly once.
  for (let start = 0; start < 9; start += 3) {
    const window = new Set(order.slice(start, start + 3));
    assert.equal(window.size, 3, `expected a fair rotation, got ${order.join("")}`);
  }
});

test("dequeue never serves a held agent; listInPlayOrder agrees", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "a1"), T0 + 1001);
  queue.enqueue(input("A", "a2"), T0 + 1002);
  queue.enqueue(input("B", "b1"), T0 + 1003);
  const held = new Set(["A"]);

  // The panel order must mirror dequeue exactly: playable first, held after.
  const listed = queue.listInPlayOrder(T0 + 10, held).map((item) => `${item.profileId}:${item.text}`);
  assert.deepEqual(listed, ["B:b1", "A:a1", "A:a2"]);

  assert.equal(queue.dequeue(T0 + 10, held)?.text, "b1");
  assert.equal(queue.dequeue(T0 + 10, held), null, "held items must never be served");
  assert.equal(queue.depth, 2, "held items stay in the queue");

  // Releasing the hold serves the backlog FIFO.
  assert.equal(queue.dequeue(T0 + 10)?.text, "a1");
  assert.equal(queue.dequeue(T0 + 10)?.text, "a2");
});

test("a promoted item overrides its agent's hold", () => {
  const queue = new UtteranceQueue(limits());
  const target = queue.enqueue(input("A", "play me"), T0 + 1001);
  queue.enqueue(input("B", "b1"), T0 + 1002);
  assert.ok(target.ok);

  queue.promote(target.item.id);
  // "Play now" is an explicit user override of the hold.
  assert.equal(queue.dequeue(T0 + 10, new Set(["A"]))?.text, "play me");
});

test("held agents are exempt from the TTL sweep and get the time credited back", () => {
  const queue = new UtteranceQueue(limits());
  queue.enqueue(input("A", "a1", { ttlMs: 1000 }), T0);
  queue.enqueue(input("B", "b1", { ttlMs: 1000 }), T0);
  const held = new Set(["A"]);

  // Way past both TTLs: only the unheld agent's item may expire.
  const expired = queue.sweepExpired(T0 + 60_000, held);
  assert.deepEqual(expired.map((item) => item.profileId), ["B"]);
  assert.equal(queue.depth, 1, "the held item must survive the sweep");

  // Credit the held time back; the item is then playable, not instantly stale.
  queue.extendTtl("A", 60_000);
  assert.equal(queue.dequeue(T0 + 60_500)?.text, "a1");
});

test("play-now serves a held item even after its TTL lapsed while held", () => {
  const queue = new UtteranceQueue(limits());
  const target = queue.enqueue(input("A", "old but promoted", { ttlMs: 1000 }), T0);
  assert.ok(target.ok);
  const held = new Set(["A"]);

  // The panel (listInPlayOrder with the held set) still shows the item, so a
  // "play now" click on it must not silently vanish.
  const listed = queue.listInPlayOrder(T0 + 60_000, held);
  assert.equal(listed.length, 1, "precondition: the panel would show this item");

  queue.promote(target.item.id);
  assert.equal(queue.dequeue(T0 + 60_000, held)?.text, "old but promoted");
});
