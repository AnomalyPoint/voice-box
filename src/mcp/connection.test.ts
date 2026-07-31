import { test } from "node:test";
import assert from "node:assert/strict";

import { VoiceBoxError } from "../shared/errors.js";
import { createLogger } from "../shared/log.js";
import type {
  DaemonState,
  RegisterAgentRequest,
  SpeakRequest,
  SpeakResponse,
} from "../shared/protocol.js";
import type { AgentProfile } from "../shared/types.js";
import { AgentConnection, isUnknownSessionError } from "./connection.js";
import type { AgentIdentity, DaemonClient } from "./daemonClient.js";

const PROFILE: AgentProfile = {
  id: "p1",
  label: "test-agent",
  projectPath: "/tmp/example-project",
  projectName: "example-project",
  voice: { providerId: "openai", voiceId: "alloy" },
  voiceLockedByUser: false,
  muted: false,
  volume: 1,
  color: "#6b7fd7",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-01T00:00:00.000Z",
};

function unknownSessionError(): VoiceBoxError {
  return new VoiceBoxError("unknown_session", "Unknown session. Reconnect and try again.", {
    retryable: true,
  });
}

/**
 * A daemon reduced to the one behavior under test: it only honors sessions it
 * currently remembers, and restart() forgets all of them -- exactly what the
 * real in-memory registry does.
 */
class FakeDaemon {
  registrations = 0;
  speakCalls = 0;
  registerAgentCalls = 0;
  /** Awaited at the top of speak; lets tests hold several calls in flight. */
  speakGate: (() => Promise<void>) | undefined;
  /** Thrown from speak instead of the liveness check, when set. */
  speakError: (() => Error | undefined) | undefined;

  private readonly live = new Set<string>();
  private nextId = 0;

  restart(): void {
    this.live.clear();
  }

  readonly client = {
    registerSession: async (_identity: AgentIdentity) => {
      this.registrations += 1;
      const sessionId = `s${++this.nextId}`;
      this.live.add(sessionId);
      return {
        sessionId,
        profile: PROFILE,
        firstSeen: this.registrations === 1,
        panelUrl: "http://127.0.0.1:4517",
      };
    },
    speak: async (request: SpeakRequest): Promise<SpeakResponse> => {
      this.speakCalls += 1;
      if (this.speakGate) await this.speakGate();
      const forced = this.speakError?.();
      if (forced) throw forced;
      if (!this.live.has(request.sessionId)) throw unknownSessionError();
      return {
        id: `u${this.speakCalls}`,
        status: "queued",
        queuePosition: 0,
        etaSeconds: 1,
        agent: { name: PROFILE.label, voice: "openai/alloy" },
      };
    },
    registerAgent: async (request: RegisterAgentRequest) => {
      this.registerAgentCalls += 1;
      if (!this.live.has(request.sessionId)) throw unknownSessionError();
      return { profile: { ...PROFILE, label: request.name }, voiceLocked: false };
    },
    endSession: async () => ({ ok: true }),
  } as unknown as DaemonClient;
}

function makeConnection(daemon: FakeDaemon): AgentConnection {
  return new AgentConnection(
    () => ({ name: "test-client" }),
    createLogger({ scope: "test", level: "silent" }),
    {
      ensureDaemon: async () => ({ state: {} as DaemonState }),
      createClient: () => daemon.client,
    },
  );
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("isUnknownSessionError matches the dedicated code and the legacy message", () => {
  assert.equal(isUnknownSessionError(unknownSessionError()), true);
  assert.equal(
    isUnknownSessionError(
      new VoiceBoxError("invalid_input", "Unknown session. Reconnect and try again."),
    ),
    true,
    "pre-unknown_session daemons must still be recognized",
  );
  assert.equal(
    isUnknownSessionError(new VoiceBoxError("invalid_input", "There is no text to speak.")),
    false,
  );
  assert.equal(isUnknownSessionError(new Error("Unknown session.")), false);
});

test("speak recovers from a daemon restart by re-registering once", async () => {
  const daemon = new FakeDaemon();
  const connection = makeConnection(daemon);

  const first = await connection.speak({ text: "hello" });
  assert.equal(first.response.status, "queued");
  assert.equal(first.session.sessionId, "s1");

  daemon.restart();

  const second = await connection.speak({ text: "still here?" });
  assert.equal(second.response.status, "queued");
  assert.equal(second.session.sessionId, "s2", "the retry must run under the fresh session");
  assert.equal(daemon.registrations, 2);
  assert.equal(daemon.speakCalls, 3, "one success, one failure, one retry");
});

test("errors other than unknown-session are not retried", async () => {
  const daemon = new FakeDaemon();
  const connection = makeConnection(daemon);
  daemon.speakError = () => new VoiceBoxError("invalid_input", "There is no text to speak.");

  await assert.rejects(connection.speak({ text: " " }), {
    message: "There is no text to speak.",
  });
  assert.equal(daemon.speakCalls, 1, "a plain validation error must not trigger a retry");
  assert.equal(daemon.registrations, 1);
});

test("a persistent unknown-session error is retried exactly once, then surfaces", async () => {
  const daemon = new FakeDaemon();
  const connection = makeConnection(daemon);
  daemon.speakError = () => unknownSessionError();

  await assert.rejects(connection.speak({ text: "hello" }), { code: "unknown_session" });
  assert.equal(daemon.speakCalls, 2);
  assert.equal(daemon.registrations, 2);

  // The failed retry must leave the cache clear so the next call self-heals.
  daemon.speakError = undefined;
  const recovered = await connection.speak({ text: "hello again" });
  assert.equal(recovered.response.status, "queued");
  assert.equal(daemon.registrations, 3);
});

test("concurrent speaks that fail together share one re-registration", async () => {
  const daemon = new FakeDaemon();
  const connection = makeConnection(daemon);

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  let gated = 0;
  daemon.speakGate = async () => {
    // Hold only the first wave; retries must run unimpeded.
    if (++gated <= 2) await barrier;
  };

  const one = connection.speak({ text: "one" });
  const two = connection.speak({ text: "two" });
  await until(() => daemon.speakCalls === 2, "both speaks in flight");

  daemon.restart();
  release();

  const [first, second] = await Promise.all([one, two]);
  assert.equal(first.response.status, "queued");
  assert.equal(second.response.status, "queued");
  assert.equal(daemon.registrations, 2, "recovery must share a single re-registration");
});

test("register recovers from a daemon restart too", async () => {
  const daemon = new FakeDaemon();
  const connection = makeConnection(daemon);

  await connection.speak({ text: "hello" });
  daemon.restart();

  const result = await connection.register("Max");
  assert.equal(result.label, "Max");
  assert.equal(daemon.registerAgentCalls, 2);
  assert.equal(daemon.registrations, 2);
});

test("speak recovers when an old daemon reports the failure as invalid_input", async () => {
  const daemon = new FakeDaemon();
  const connection = makeConnection(daemon);
  let failures = 1;
  daemon.speakError = () =>
    failures-- > 0
      ? new VoiceBoxError("invalid_input", "Unknown session. Reconnect and try again.")
      : undefined;

  const result = await connection.speak({ text: "hello" });
  assert.equal(result.response.status, "queued");
  assert.equal(daemon.speakCalls, 2);
  assert.equal(daemon.registrations, 2);
});
