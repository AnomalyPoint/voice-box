import { test } from "node:test";
import assert from "node:assert/strict";

import { redactString, redactValue, maskSecret } from "./redact.js";

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const ELEVEN_KEY = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";

test("redacts OpenAI keys anywhere in a string", () => {
  const out = redactString(`request failed using ${OPENAI_KEY} at 10:00`);
  assert.ok(!out.includes(OPENAI_KEY));
  assert.ok(out.includes("[redacted]"));
});

test("redacts ElevenLabs keys and bearer tokens", () => {
  assert.ok(!redactString(`xi-api-key: ${ELEVEN_KEY}`).includes(ELEVEN_KEY));
  const bearer = "Bearer abcdefghijklmnopqrstuvwxyz012345";
  assert.ok(!redactString(bearer).includes("abcdefghijklmnop"));
});

test("redacts values under secret-looking keys whatever their shape", () => {
  const out = redactValue({
    apiKey: "totally-not-key-shaped",
    api_key: "x",
    token: "plainvalue",
    authorization: "anything",
    voice: "nova",
  }) as Record<string, unknown>;

  assert.equal(out["apiKey"], "[redacted]");
  assert.equal(out["api_key"], "[redacted]");
  assert.equal(out["token"], "[redacted]");
  assert.equal(out["authorization"], "[redacted]");
  // Non-secret fields must survive or logs become useless.
  assert.equal(out["voice"], "nova");
});

test("redacts through nesting and arrays", () => {
  const out = redactValue({
    providers: [{ name: "openai", secrets: { apiKey: OPENAI_KEY } }],
    note: `key is ${OPENAI_KEY}`,
  });
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes(OPENAI_KEY), "no key may survive anywhere in the tree");
});

test("errors are reduced to name and message, with the message redacted", () => {
  const out = redactValue(new Error(`bad key ${OPENAI_KEY}`)) as Record<string, unknown>;
  assert.equal(out["name"], "Error");
  assert.ok(!String(out["message"]).includes(OPENAI_KEY));
});

test("does not recurse without bound on cyclic input", () => {
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic["self"] = cyclic;
  const serialized = JSON.stringify(redactValue(cyclic));
  assert.ok(serialized.includes("depth-limit"));
});

test("maskSecret reveals a recognizable hint but never the key", () => {
  const masked = maskSecret(OPENAI_KEY);
  assert.equal(masked, "sk-…ABCD");
  assert.ok(!masked.includes("proj"));
  assert.ok(masked.length < 12);
});

test("maskSecret does not leak short values", () => {
  assert.ok(!maskSecret("short").includes("short"));
});
