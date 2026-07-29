import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIO_BACKENDS, backendsForPlatform, findBackendSpec } from "./backends.js";

const spec = (id: string) => {
  const found = findBackendSpec(id);
  assert.ok(found, `expected backend ${id} to exist`);
  return found;
};

test("afplay receives a clamped 0..1 volume and the file last", () => {
  const args = spec("afplay").buildArgs("/tmp/a.mp3", 0.5);
  assert.deepEqual(args, ["-v", "0.500", "/tmp/a.mp3"]);
});

test("volume is clamped rather than passed through out of range", () => {
  assert.deepEqual(spec("afplay").buildArgs("/tmp/a.mp3", 9), ["-v", "1.000", "/tmp/a.mp3"]);
  assert.deepEqual(spec("afplay").buildArgs("/tmp/a.mp3", -3), ["-v", "0.000", "/tmp/a.mp3"]);
});

test("ffplay converts volume to its 0..100 scale and never opens a window", () => {
  const args = spec("ffplay").buildArgs("/tmp/a.mp3", 0.5);
  assert.ok(args.includes("-nodisp"), "must not open a video window");
  assert.ok(args.includes("-autoexit"), "must exit when the file ends");
  assert.deepEqual(args.slice(-3), ["-volume", "50", "/tmp/a.mp3"]);
});

test("mpg123 converts volume to its linear 32768-unity scale", () => {
  assert.deepEqual(spec("mpg123").buildArgs("/tmp/a.mp3", 1), ["-q", "-f", "32768", "/tmp/a.mp3"]);
  assert.deepEqual(spec("mpg123").buildArgs("/tmp/a.mp3", 0), ["-q", "-f", "0", "/tmp/a.mp3"]);
});

test("PowerShell backends invoke the shipped script file, not an inline command", () => {
  for (const id of ["pwsh", "powershell"]) {
    const args = spec(id).buildArgs("C:\\tmp\\a.mp3", 0.8);
    assert.ok(args.includes("-File"), `${id} must use -File to dodge quoting issues`);
    assert.ok(args.includes("-NoProfile"), `${id} must not load a user profile`);
    assert.ok(
      args.some((arg) => arg.endsWith("win-play.ps1")),
      `${id} must point at the shipped script`,
    );
    assert.ok(args.includes("C:\\tmp\\a.mp3"));
  }
});

test("every backend puts the file path in its argv verbatim", () => {
  const file = "/tmp/with space/utterance.mp3";
  for (const backend of AUDIO_BACKENDS) {
    assert.ok(
      backend.buildArgs(file, 1).includes(file),
      `${backend.id} must pass the path as a single argv entry (no shell quoting)`,
    );
  }
});

test("aplay and paplay are excluded -- they cannot decode MP3", () => {
  // Handing an MP3 to a WAV-only player produces loud static rather than a
  // clean failure, which is worse than having no backend at all.
  for (const id of ["aplay", "paplay"]) {
    assert.equal(findBackendSpec(id), undefined, `${id} must not be a candidate`);
  }
});

test("platform filtering yields only usable candidates", () => {
  const darwin = backendsForPlatform("darwin").map((b) => b.id);
  assert.ok(darwin.includes("afplay"));
  assert.ok(!darwin.includes("powershell"));

  const win = backendsForPlatform("win32").map((b) => b.id);
  assert.ok(win.includes("powershell"));
  assert.ok(!win.includes("afplay"));

  const linux = backendsForPlatform("linux").map((b) => b.id);
  assert.ok(linux.includes("mpg123"));
  assert.ok(!linux.includes("afplay"));
});

test("afplay is preferred on macOS -- it ships with the OS", () => {
  assert.equal(backendsForPlatform("darwin")[0]?.id, "afplay");
});
