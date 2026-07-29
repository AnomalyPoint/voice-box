import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPaths } from "../../shared/paths.js";
import { ConfigStore } from "./store.js";

const isWindows = process.platform === "win32";
const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

async function withTempStore(run: (store: ConfigStore, home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "voice-box-test-"));
  const previousOpenAi = process.env["OPENAI_API_KEY"];
  const previousEleven = process.env["ELEVENLABS_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["ELEVENLABS_API_KEY"];
  try {
    await run(await ConfigStore.load(getPaths(home)), home);
  } finally {
    if (previousOpenAi !== undefined) process.env["OPENAI_API_KEY"] = previousOpenAi;
    if (previousEleven !== undefined) process.env["ELEVENLABS_API_KEY"] = previousEleven;
    await rm(home, { recursive: true, force: true });
  }
}

test("a fresh load produces usable defaults without any files", async () => {
  await withTempStore(async (store) => {
    assert.equal(store.config.schemaVersion, 1);
    assert.equal(store.config.audio.backend, "auto");
    assert.equal(store.config.voice.default.providerId, "openai");
    assert.equal(store.config.voice.default.voiceId, "nova");
  });
});

test("secrets.json is written 0600 inside a 0700 home", async (t) => {
  if (isWindows) return t.skip("POSIX permissions are not meaningful on Windows");
  await withTempStore(async (store, home) => {
    await store.setApiKey("openai", KEY);
    const secrets = await stat(getPaths(home).secretsFile);
    assert.equal(secrets.mode & 0o777, 0o600, "secrets must not be group/world readable");
    const dir = await stat(home);
    assert.equal(dir.mode & 0o777, 0o700);
  });
});

test("environment variables take precedence over the stored key", async () => {
  await withTempStore(async (store) => {
    await store.setApiKey("openai", "sk-from-file-000000000000000000");
    assert.equal(store.getSecretSource("openai"), "file");

    process.env["OPENAI_API_KEY"] = KEY;
    try {
      assert.equal(store.getApiKey("openai"), KEY, "env must win so a shell can override the UI");
      assert.equal(store.getSecretSource("openai"), "env");
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });
});

test("describeSecrets never exposes the raw key", async () => {
  await withTempStore(async (store) => {
    await store.setApiKey("openai", KEY);
    const described = store.describeSecrets();
    const serialized = JSON.stringify(described);

    assert.ok(!serialized.includes(KEY), "the raw key must never leave the daemon");
    const openai = described.find((entry) => entry.providerId === "openai");
    assert.equal(openai?.configured, true);
    assert.equal(openai?.hint, "sk-…ABCD");

    const eleven = described.find((entry) => entry.providerId === "elevenlabs");
    assert.equal(eleven?.configured, false);
    assert.equal(eleven?.hint, null);
  });
});

test("keys survive a reload and can be cleared", async () => {
  await withTempStore(async (store, home) => {
    await store.setApiKey("elevenlabs", KEY);

    const reloaded = await ConfigStore.load(getPaths(home));
    assert.equal(reloaded.getApiKey("elevenlabs"), KEY);

    await reloaded.clearApiKey("elevenlabs");
    assert.equal(reloaded.getApiKey("elevenlabs"), undefined);

    const again = await ConfigStore.load(getPaths(home));
    assert.equal(again.getApiKey("elevenlabs"), undefined);
  });
});

test("config updates persist atomically and are re-validated", async () => {
  await withTempStore(async (store, home) => {
    await store.update((draft) => ({ ...draft, audio: { ...draft.audio, volume: 0.5 } }));
    const reloaded = await ConfigStore.load(getPaths(home));
    assert.equal(reloaded.config.audio.volume, 0.5);

    await assert.rejects(
      () => store.update((draft) => ({ ...draft, audio: { ...draft.audio, volume: 9 } })),
      "volume above 1.0 must be rejected rather than persisted",
    );
  });
});

test("config.json holds no secrets, so it is safe to share", async () => {
  await withTempStore(async (store, home) => {
    await store.setApiKey("openai", KEY);
    await store.update((draft) => draft);
    const configText = await readFile(getPaths(home).configFile, "utf8");
    assert.ok(!configText.includes(KEY));
    assert.ok(!configText.toLowerCase().includes("apikey"));
  });
});
