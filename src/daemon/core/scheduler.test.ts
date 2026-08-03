import { test } from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../../shared/log.js";
import type { VoiceSelection } from "../../shared/types.js";
import type { AudioPlayer, PlaybackHandle, PlaybackOutcome } from "../audio/index.js";
import type { ConfigStore } from "../config/store.js";
import type { AgentRegistry } from "./registry.js";
import type { HistoryEntry, HistoryLog } from "./history.js";
import type { Synthesizer } from "./synthesizer.js";
import { Scheduler } from "./scheduler.js";

const VOICE: VoiceSelection = { providerId: "openai", voiceId: "nova" };

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

/** A playback handle the test resolves by hand. */
class FakeHandle implements PlaybackHandle {
  resolveDone!: (outcome: PlaybackOutcome) => void;
  readonly done = new Promise<PlaybackOutcome>((resolve) => {
    this.resolveDone = resolve;
  });
  pauseCalls = 0;
  resumeCalls = 0;
  stopped = false;
  private pausedFlag = false;

  stop(): void {
    this.stopped = true;
    this.resolveDone({ status: "stopped" });
  }
  pause(): boolean {
    this.pauseCalls++;
    this.pausedFlag = true;
    return true;
  }
  resume(): boolean {
    this.resumeCalls++;
    this.pausedFlag = false;
    return true;
  }
  get paused(): boolean {
    return this.pausedFlag;
  }
}

class FakePlayer {
  readonly plays: { file: string; volume: number; handle: FakeHandle }[] = [];
  readonly backend = {
    id: "fake",
    label: "Fake",
    executable: "/bin/fake",
    supportsVolume: true,
    supportsHardPause: true,
  };
  play(file: string, options?: { volume?: number }): PlaybackHandle {
    const handle = new FakeHandle();
    this.plays.push({ file, volume: options?.volume ?? 1, handle });
    return handle;
  }
}

function makeDeps(overrides: {
  synthesize?: (
    text: string,
    voice: VoiceSelection,
    signal?: AbortSignal,
  ) => Promise<{ file: string; key: string }>;
} = {}) {
  const profile = {
    id: "p1",
    label: "Max",
    projectPath: "/tmp/proj",
    projectName: "proj",
    voice: VOICE,
    voiceLockedByUser: false,
    muted: false,
    volume: 0.8,
    color: "#fff",
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  const profile2 = { ...profile, id: "p2", label: "Nova", volume: 1 };
  const profiles: Record<string, typeof profile> = { p1: profile, p2: profile2 };

  const store = {
    config: {
      audio: { volume: 0.5, backend: "auto" },
      queue: {
        maxDepth: 50,
        maxPerAgent: 8,
        overflow: "dropOldestFromSameAgent",
        defaultPriority: "normal",
        defaultWait: "none",
        backpressureThreshold: 100,
        backpressureTimeoutMs: 100,
        purgeOnDisconnect: true,
        ttlSeconds: { low: 600, normal: 600, high: 600, urgent: 600 },
      },
    },
  } as unknown as ConfigStore;

  const registry = {
    // Session "s2" belongs to a second agent; everything else maps to p1.
    requireSession: (sessionId: string) => ({
      sessionId,
      profileId: sessionId === "s2" ? "p2" : "p1",
    }),
    touch: () => {},
    requireProfile: (id: string) => profiles[id] ?? profile,
    getProfile: (id: string) => profiles[id],
  } as unknown as AgentRegistry;

  let counter = 0;
  const synthesize =
    overrides.synthesize ??
    (async (text: string) => ({ file: `/tmp/audio-${text}.mp3`, key: `key-${counter++}` }));

  const synthesizer = {
    providerFor: () => ({ isConfigured: () => true }),
    notConfiguredError: () => new Error("not configured"),
    synthesize,
  } as unknown as Synthesizer;

  const appended: HistoryEntry[] = [];
  const history = {
    append: (entry: HistoryEntry) => {
      appended.push(entry);
    },
  } as unknown as HistoryLog;

  const player = new FakePlayer();
  const scheduler = new Scheduler({
    store,
    registry,
    synthesizer,
    player: player as unknown as AudioPlayer,
    history,
    logger,
  });

  return { scheduler, player, appended, profile, profile2 };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

test("pause freezes the current utterance mid-word and resume continues it", async () => {
  const { scheduler, player } = makeDeps();

  await scheduler.speak({ sessionId: "s1", text: "hello world" });
  await until(() => player.plays.length === 1, "first play to start");
  const first = player.plays[0]!.handle;

  scheduler.pause();
  assert.equal(first.pauseCalls, 1, "hard pause must reach the player process");
  assert.equal(scheduler.snapshot().frozenMidUtterance, true);
  assert.equal(scheduler.snapshot().paused, true);

  // Speech arriving while paused queues up; nothing new plays.
  await scheduler.speak({ sessionId: "s1", text: "second line" });
  assert.equal(scheduler.snapshot().pending.length, 1);
  assert.equal(player.plays.length, 1);

  scheduler.resume();
  assert.equal(first.resumeCalls, 1, "resume must reach the frozen player");

  first.resolveDone({ status: "completed" });
  await until(() => player.plays.length === 2, "queued line to play after resume");
  player.plays[1]!.handle.resolveDone({ status: "completed" });
  await until(() => scheduler.snapshot().playing === null, "queue to drain");
});

test("pause during synthesis holds the utterance un-played until resume", async () => {
  let releaseSynth!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSynth = resolve;
  });
  const { scheduler, player } = makeDeps({
    synthesize: async (text) => {
      await gate;
      return { file: `/tmp/${text}.mp3`, key: "k1" };
    },
  });

  await scheduler.speak({ sessionId: "s1", text: "slow synth" });
  await until(() => scheduler.snapshot().playing?.status === "synthesizing", "synthesis to start");

  scheduler.pause();
  releaseSynth();
  // Give the pump every chance to (wrongly) start playback.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.plays.length, 0, "must not start speaking while paused");

  scheduler.resume();
  await until(() => player.plays.length === 1, "held utterance to play on resume");
  player.plays[0]!.handle.resolveDone({ status: "completed" });
});

test("skip during synthesis aborts it and the audio never plays", async () => {
  const { scheduler, player, appended } = makeDeps({
    synthesize: (_text, _voice, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });

  await scheduler.speak({ sessionId: "s1", text: "never heard" });
  await until(() => scheduler.snapshot().playing?.status === "synthesizing", "synthesis to start");

  assert.equal(scheduler.skip(), true);
  await until(() => appended.length === 1, "the skip to settle");
  assert.equal(appended[0]?.status, "skipped");
  assert.equal(player.plays.length, 0, "aborted synthesis must never reach the speakers");
});

test("replay plays immediately while paused and the queue stays held", async () => {
  const { scheduler, player } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "queued while paused" });

  const status = await scheduler.playUserAudio({
    label: "Max (replay)",
    text: "an older memo",
    file: "/tmp/replay.mp3",
    volume: 0.4,
  });
  assert.equal(status, "playing", "replay must not wait for resume");
  assert.equal(player.plays.length, 1);
  assert.equal(player.plays[0]?.file, "/tmp/replay.mp3");
  assert.equal(scheduler.snapshot().userPlayback?.label, "Max (replay)");
  assert.equal(scheduler.snapshot().pending.length, 1, "agent queue must stay held");

  player.plays[0]!.handle.resolveDone({ status: "completed" });
  await until(() => scheduler.snapshot().userPlayback === null, "replay to finish");
  assert.equal(scheduler.snapshot().paused, true, "finishing a replay must not unpause");

  scheduler.resume();
  await until(() => player.plays.length === 2, "queued line to play after resume");
  player.plays[1]!.handle.resolveDone({ status: "completed" });
});

test("replay while an agent is mid-sentence slots in right after it", async () => {
  const { scheduler, player } = makeDeps();

  await scheduler.speak({ sessionId: "s1", text: "live line" });
  await until(
    () => player.plays.length === 1 && scheduler.snapshot().playing?.status === "playing",
    "live line to start",
  );

  const status = await scheduler.playUserAudio({
    label: "Max (replay)",
    text: "an older memo",
    file: "/tmp/replay.mp3",
    volume: 0.4,
  });
  assert.equal(status, "queued", "must not talk over the live line");
  assert.equal(player.plays.length, 1);

  player.plays[0]!.handle.resolveDone({ status: "completed" });
  await until(() => player.plays.length === 2, "replay to play next");
  assert.equal(player.plays[1]?.file, "/tmp/replay.mp3");
  player.plays[1]!.handle.resolveDone({ status: "completed" });
});

test("clear settles the pending items so history records them", async () => {
  const { scheduler, appended } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "one" });
  await scheduler.speak({ sessionId: "s1", text: "two" });

  assert.equal(scheduler.clear(), 2);
  assert.equal(scheduler.snapshot().pending.length, 0);
  assert.equal(appended.length, 2);
  assert.ok(appended.every((entry) => entry.status === "skipped"));
});

test("playNow moves an item to the front of the play order", async () => {
  const { scheduler } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "first" });
  await scheduler.speak({ sessionId: "s1", text: "second" });
  const third = await scheduler.speak({ sessionId: "s1", text: "third" });

  assert.equal(scheduler.playNow(third.id), true);
  const pending = scheduler.snapshot().pending;
  assert.equal(pending[0]?.text, "third");
  assert.equal(scheduler.playNow("nope"), false);
});

test("a replay started during synthesis finishes before the agent line plays", async () => {
  let releaseSynth!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSynth = resolve;
  });
  const { scheduler, player } = makeDeps({
    synthesize: async (text) => {
      if (text === "slow line") await gate;
      return { file: `/tmp/${text}.mp3`, key: `k-${text}` };
    },
  });

  await scheduler.speak({ sessionId: "s1", text: "slow line" });
  await until(() => scheduler.snapshot().playing?.status === "synthesizing", "synthesis to start");

  // Nothing is audible yet, so the replay grabs the speakers immediately.
  const status = await scheduler.playUserAudio({
    label: "Max (replay)",
    text: "an older memo",
    file: "/tmp/replay.mp3",
    volume: 0.4,
  });
  assert.equal(status, "playing");

  releaseSynth();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.plays.length, 1, "agent line must wait for the replay to finish");

  player.plays[0]!.handle.resolveDone({ status: "completed" });
  await until(() => player.plays.length === 2, "agent line to play after the replay");
  assert.equal(player.plays[1]?.file, "/tmp/slow line.mp3");
  player.plays[1]!.handle.resolveDone({ status: "completed" });
});

test("queued user audio is not double-scaled by master volume", async () => {
  const { scheduler, player } = makeDeps();

  await scheduler.speak({ sessionId: "s1", text: "live line" });
  await until(
    () => player.plays.length === 1 && scheduler.snapshot().playing?.status === "playing",
    "live line to start",
  );

  // Routes pre-multiply master volume; 0.4 arrives ready-to-play.
  const status = await scheduler.playUserAudio({
    label: "Max (replay)",
    text: "memo",
    file: "/tmp/replay.mp3",
    volume: 0.4,
  });
  assert.equal(status, "queued");

  player.plays[0]!.handle.resolveDone({ status: "completed" });
  await until(() => player.plays.length === 2, "replay to play");
  assert.ok(
    Math.abs(player.plays[1]!.volume - 0.4) < 1e-9,
    `expected 0.4, got ${player.plays[1]!.volume} (master applied twice?)`,
  );
  player.plays[1]!.handle.resolveDone({ status: "completed" });
});

test("playback volume is master times profile volume", async () => {
  const { scheduler, player } = makeDeps();

  await scheduler.speak({ sessionId: "s1", text: "check volume" });
  await until(() => player.plays.length === 1, "play to start");
  // profile 0.8 * master 0.5
  assert.ok(Math.abs(player.plays[0]!.volume - 0.4) < 1e-9);
  player.plays[0]!.handle.resolveDone({ status: "completed" });
});

test("volume is read at play time, not frozen at enqueue time", async () => {
  const { scheduler, player, profile } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "queued before the slider moved" });
  // The user drags the slider while the item is still queued.
  profile.volume = 0.2;
  scheduler.resume();

  await until(() => player.plays.length === 1, "queued line to play");
  // 0.2 (current profile) * 0.5 (master) -- not the 0.8 snapshotted at enqueue.
  assert.ok(
    Math.abs(player.plays[0]!.volume - 0.1) < 1e-9,
    `expected 0.1, got ${player.plays[0]!.volume} (enqueue-time snapshot?)`,
  );
  player.plays[0]!.handle.resolveDone({ status: "completed" });
});

test("applyLiveVolume pushes the new volume into the playing handle", async () => {
  const { scheduler, player, profile } = makeDeps();

  const setVolumes: number[] = [];
  const originalPlay = player.play.bind(player);
  player.play = (file: string, options?: { volume?: number }) => {
    const handle = originalPlay(file, options) as FakeHandle & {
      setVolume?: (v: number) => boolean;
    };
    handle.setVolume = (v: number) => {
      setVolumes.push(v);
      return true;
    };
    return handle;
  };

  await scheduler.speak({ sessionId: "s1", text: "live volume" });
  await until(() => player.plays.length === 1, "play to start");

  profile.volume = 0.6;
  scheduler.applyLiveVolume();
  assert.equal(setVolumes.length, 1, "the live handle must receive the change");
  assert.ok(Math.abs(setVolumes[0]! - 0.3) < 1e-9, "0.6 profile x 0.5 master");
  player.plays[0]!.handle.resolveDone({ status: "completed" });
});

test("holding an agent finishes its sentence, then others play while it waits", async () => {
  const { scheduler, player } = makeDeps();

  await scheduler.speak({ sessionId: "s1", text: "p1 first line" });
  await until(
    () => player.plays.length === 1 && scheduler.snapshot().playing?.status === "playing",
    "p1 to start speaking",
  );
  await scheduler.speak({ sessionId: "s1", text: "p1 second line" });
  await scheduler.speak({ sessionId: "s2", text: "p2 first line" });

  scheduler.pauseAgent("p1");
  const snap = scheduler.snapshot();
  assert.deepEqual(snap.pausedProfiles, ["p1"]);
  assert.equal(snap.playing?.text, "p1 first line", "the current sentence must finish");
  assert.equal(player.plays[0]!.handle.stopped, false, "a hold must never cut audio mid-word");

  player.plays[0]!.handle.resolveDone({ status: "completed" });
  await until(() => player.plays.length === 2, "the other agent to take the lane");
  assert.equal(player.plays[1]?.file, "/tmp/audio-p2 first line.mp3");
  player.plays[1]!.handle.resolveDone({ status: "completed" });

  // p1's backlog stays put -- and stays visible, sorted after playable items.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.plays.length, 2, "held agent must not play");
  const pending = scheduler.snapshot().pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "p1 second line");

  scheduler.resumeAgent("p1");
  await until(() => player.plays.length === 3, "held line to play after resume");
  assert.equal(player.plays[2]?.file, "/tmp/audio-p1 second line.mp3");
  player.plays[2]!.handle.resolveDone({ status: "completed" });
});

test("held items sort after every playable item in the panel order", async () => {
  const { scheduler } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "p1 a" });
  await scheduler.speak({ sessionId: "s1", text: "p1 b" });
  await scheduler.speak({ sessionId: "s2", text: "p2 a" });

  scheduler.pauseAgent("p1");
  const pending = scheduler.snapshot().pending;
  assert.equal(pending.length, 3, "held items must stay visible");
  assert.equal(pending[0]?.text, "p2 a", "playable items come first");
  assert.equal(pending[1]?.text, "p1 a");
  assert.equal(pending[2]?.text, "p1 b");
});

test("a hung player cannot wedge the lane: the watchdog recovers it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { scheduler, player, appended } = makeDeps();

  await scheduler.speak({ sessionId: "s1", text: "this player hangs" });
  await until(() => player.plays.length === 1, "play to start");

  // Never resolve the handle. Advance mocked time past the 120s floor.
  t.mock.timers.tick(150_000);
  await until(() => appended.length === 1, "the watchdog to settle the item");
  assert.equal(appended[0]?.status, "failed");
  assert.equal(player.plays[0]!.handle.stopped, true, "the wedged process must be stopped");

  // The lane must still work afterwards.
  await scheduler.speak({ sessionId: "s1", text: "recovered" });
  await until(() => player.plays.length === 2, "the lane to recover");
  player.plays[1]!.handle.resolveDone({ status: "completed" });
});

test("global pause with a boundary-only backend lets the sentence finish, then holds", async () => {
  const { scheduler, player } = makeDeps();
  // Simulate afplay: no control channel, pause() reports failure.
  const originalPlay = player.play.bind(player);
  player.play = (file: string, options?: { volume?: number }) => {
    const handle = originalPlay(file, options) as FakeHandle;
    handle.pause = () => false;
    return handle;
  };

  await scheduler.speak({ sessionId: "s1", text: "boundary line" });
  await until(
    () => player.plays.length === 1 && scheduler.snapshot().playing?.status === "playing",
    "line to start",
  );
  await scheduler.speak({ sessionId: "s1", text: "next line" });

  scheduler.pause();
  assert.equal(scheduler.snapshot().paused, true);
  assert.equal(scheduler.snapshot().frozenMidUtterance, false, "no freeze without a control channel");
  assert.equal(player.plays[0]!.handle.stopped, false, "the sentence must be allowed to finish");

  player.plays[0]!.handle.resolveDone({ status: "completed" });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.plays.length, 1, "nothing new may start while paused");

  scheduler.resume();
  await until(() => player.plays.length === 2, "queue to continue after resume");
  player.plays[1]!.handle.resolveDone({ status: "completed" });
});

test("a hold dies with its agent: session end clears it and items expire again", async () => {
  const { scheduler } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "left behind" });
  scheduler.pauseAgent("p1");
  assert.deepEqual(scheduler.snapshot().pausedProfiles, ["p1"]);

  scheduler.onSessionEnd("p1");
  assert.deepEqual(
    scheduler.snapshot().pausedProfiles,
    [],
    "a hold outliving its agent would immortalize its queue items",
  );
});

test("speaking while held returns immediately with a warning instead of hanging", async () => {
  const { scheduler } = makeDeps();

  scheduler.pauseAgent("p1");
  const started = Date.now();
  const outcome = await scheduler.speak({ sessionId: "s1", text: "patient line", wait: "played" });
  assert.ok(Date.now() - started < 1_000, "must not sit on the wait:'played' deadline");
  assert.equal(outcome.status, "queued");
  assert.match(outcome.warning ?? "", /paused/i);
});

test("skip stops a sounding replay and leaves the agent queue alone", async () => {
  const { scheduler, player } = makeDeps();

  scheduler.pause();
  await scheduler.speak({ sessionId: "s1", text: "queued line" });
  await scheduler.playUserAudio({
    label: "Max (replay)",
    text: "memo",
    file: "/tmp/replay.mp3",
    volume: 0.4,
  });
  assert.equal(scheduler.snapshot().userPlayback?.label, "Max (replay)");

  assert.equal(scheduler.skip(), true, "skip must act on the audible replay");
  assert.equal(player.plays[0]!.handle.stopped, true);
  assert.equal(scheduler.snapshot().userPlayback, null);
  assert.equal(scheduler.snapshot().pending.length, 1, "the agent queue must survive the skip");
});
