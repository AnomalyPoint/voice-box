import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../../shared/log.js";
import { getPaths } from "../../shared/paths.js";
import { ConfigStore } from "../config/store.js";
import { ProviderRegistry } from "../providers/registry.js";
import { AgentRegistry } from "./registry.js";

/** A pid that cannot be running: pid 0 is never a normal process. */
const DEAD_PID = 0;
const LIVE_PID = process.pid;

const PROJECT = {
  projectPath: "/tmp/example-project",
  projectName: "example-project",
  client: "claude-code",
};

async function withRegistry(run: (registry: AgentRegistry) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "voice-box-registry-"));
  const previous = process.env["OPENAI_API_KEY"];
  // A configured provider is needed so voices can be auto-assigned.
  process.env["OPENAI_API_KEY"] = "sk-test-000000000000000000000000";
  try {
    const store = await ConfigStore.load(getPaths(home));
    const providers = ProviderRegistry.create(store);
    const logger = createLogger({ scope: "test", level: "silent" });
    await run(new AgentRegistry(store, providers, logger));
  } finally {
    if (previous === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("reconnecting reuses the profile instead of creating another", async () => {
  await withRegistry(async (registry) => {
    const first = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    assert.equal(first.firstSeen, true);
    registry.endSession(first.session.sessionId);

    const second = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    assert.equal(second.profile.id, first.profile.id, "the same identity must come back");
    assert.equal(second.firstSeen, false);
    assert.equal(registry.listProfiles().length, 1);
  });
});

test("a second concurrent agent in one project gets its own slot and voice", async () => {
  await withRegistry(async (registry) => {
    const first = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    const second = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });

    assert.notEqual(second.profile.id, first.profile.id);
    assert.equal(first.profile.label, "example-project");
    assert.equal(second.profile.label, "example-project #2");
    assert.notEqual(
      second.profile.voice.voiceId,
      first.profile.voice.voiceId,
      "concurrent agents must be audibly distinguishable",
    );
  });
});

test("a crashed agent's slot is reclaimed rather than sprawling", async () => {
  await withRegistry(async (registry) => {
    // Registered and then "crashed": no endSession is ever sent.
    const crashed = await registry.registerSession({ ...PROJECT, pid: DEAD_PID });

    const revived = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    assert.equal(revived.profile.id, crashed.profile.id, "the dead session must release its slot");
    assert.equal(registry.listProfiles().length, 1);
  });
});

test("repeated crash-reconnects do not grow the profile list", async () => {
  await withRegistry(async (registry) => {
    for (let i = 0; i < 10; i++) {
      await registry.registerSession({ ...PROJECT, pid: DEAD_PID });
    }
    assert.equal(registry.listProfiles().length, 1, "identity must not sprawl across restarts");
    assert.equal(registry.listSessions().length, 1, "only the newest session should remain");
  });
});

test("a live session is never reaped", async () => {
  await withRegistry(async (registry) => {
    await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    assert.equal(registry.reapDeadSessions().length, 0);
    assert.equal(registry.listSessions().length, 1);
  });
});

test("renaming is in place and repeatable", async () => {
  await withRegistry(async (registry) => {
    const binding = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    for (let i = 0; i < 3; i++) await registry.rename(binding.profile.id, "Max");

    const profiles = registry.listProfiles();
    assert.equal(profiles.length, 1, "renaming must never create a second identity");
    assert.equal(profiles[0]?.label, "Max");
  });
});

test("the user's voice choice outranks the agent's", async () => {
  await withRegistry(async (registry) => {
    const binding = await registry.registerSession({ ...PROJECT, pid: LIVE_PID });
    const chosen = { providerId: "openai" as const, voiceId: "onyx", modelId: "tts-1" };

    await registry.setVoice(binding.profile.id, chosen, "user");
    const attempt = await registry.setVoice(
      binding.profile.id,
      { providerId: "openai", voiceId: "shimmer", modelId: "tts-1" },
      "agent",
    );

    assert.equal(attempt.applied, false, "an agent must not override a user's choice");
    assert.equal(attempt.profile.voice.voiceId, "onyx");
  });
});

test("an explicitly named agent reclaims its own identity", async () => {
  await withRegistry(async (registry) => {
    const first = await registry.registerSession({
      ...PROJECT,
      pid: DEAD_PID,
      preferredLabel: "Max",
    });
    assert.equal(first.profile.label, "Max");

    const again = await registry.registerSession({
      ...PROJECT,
      pid: LIVE_PID,
      preferredLabel: "Max",
    });
    assert.equal(again.profile.id, first.profile.id);
  });
});
