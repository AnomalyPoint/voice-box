#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { runDoctor } from "./daemon/doctor.js";
import { ConfigStore } from "./daemon/config/store.js";
import { ProviderRegistry } from "./daemon/providers/registry.js";
import { DaemonClient, deriveIdentity } from "./mcp/daemonClient.js";
import { ensureDaemon } from "./mcp/ensureDaemon.js";
import {
  isProcessAlive,
  probeDaemon,
  readDaemonState,
  removeDaemonStateFile,
} from "./shared/daemonState.js";
import { createLogger } from "./shared/log.js";
import { getPaths } from "./shared/paths.js";
import { toVoiceBoxError, VoiceBoxError } from "./shared/errors.js";
import { isProviderId } from "./shared/types.js";
import { PKG_VERSION } from "./version.js";

const HELP = `
Voice Box ${PKG_VERSION} -- local voice control panel for AI agents

Usage
  voice-box <command> [options]

Commands
  (none)                 Start the daemon and open the control panel
  mcp                    Run the MCP stdio server (what MCP clients invoke)
  daemon                 Run the daemon in the foreground (for debugging)
  start [--open]         Start the daemon (--open also opens the panel)
  stop | restart         Manage the background daemon
  status                 Show agents and the speech queue
  logs [-n N]            Show the daemon log
  speak <text>           Queue something to say, for testing
  keys set <provider>    Store an API key, read from stdin so it stays out of history
  keys clear <provider>  Remove a stored API key
  doctor [--selftest]    Diagnose the installation
  help                   Show this message

Options
  -v, --version          Print the version

MCP client configuration
  {
    "mcpServers": {
      "voice-box": {
        "command": "npx",
        "args": ["-y", "@anomalypoint/voice-box@latest", "mcp"]
      }
    }
  }

Keys live in ~/.voice-box/secrets.json (0600). OPENAI_API_KEY and
ELEVENLABS_API_KEY always take precedence.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
      // Bare `voice-box` is a human at a terminal: bring up the panel.
      return startCommand(true);

    case "start":
      return startCommand(rest.includes("--open"));

    case "mcp": {
      const { runMcpServer } = await import("./mcp/main.js");
      await runMcpServer();
      return -1; // long-running
    }

    case "daemon": {
      const { runDaemon } = await import("./daemon/main.js");
      // -1 keeps the process alive to serve; a loser exits 0 immediately rather
      // than lingering on the chance that the event loop happens to drain.
      return (await runDaemon()) ? -1 : 0;
    }

    case "stop":
      return stopCommand();

    case "restart":
      await stopCommand();
      return startCommand(false);

    case "status":
      return statusCommand();

    case "logs":
      return logsCommand(rest);

    case "speak":
      return speakCommand(rest);

    case "keys":
      return keysCommand(rest);

    case "doctor":
      return runDoctor({ selftest: rest.includes("--selftest") });

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    case "--version":
    case "-v":
      console.log(PKG_VERSION);
      return 0;

    default:
      console.error(`Unknown command: ${command}\nRun \`voice-box help\` for usage.`);
      return 1;
  }
}

const quietLogger = () => createLogger({ scope: "cli", level: "warn" });

async function startCommand(openPanel: boolean): Promise<number> {
  const { state } = await ensureDaemon(quietLogger());
  const url = `http://${state.host}:${state.port}`;
  console.log(`Voice Box running at ${url} (pid ${state.pid})`);

  if (openPanel) {
    // The token rides in the fragment, never the query string, so it stays out
    // of server logs and Referer headers. The page swaps it for a cookie and
    // wipes the fragment immediately.
    openInBrowser(`${url}/#t=${encodeURIComponent(state.token)}`);
  }
  return statusCommand();
}

/** Best-effort browser launch; never fatal, since the URL is printed anyway. */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless or no handler -- the printed URL is the fallback */
  }
}

async function stopCommand(): Promise<number> {
  const paths = getPaths();
  const state = await readDaemonState(paths);
  if (!state) {
    console.log("No daemon is running.");
    return 0;
  }

  if (!isProcessAlive(state.pid)) {
    await removeDaemonStateFile(paths);
    console.log("Cleared stale daemon state.");
    return 0;
  }

  process.kill(state.pid, "SIGTERM");
  // Give it a moment to release the port and its state file.
  for (let i = 0; i < 30; i++) {
    if (!isProcessAlive(state.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`Stopped daemon (pid ${state.pid}).`);
  return 0;
}

async function statusCommand(): Promise<number> {
  const paths = getPaths();
  const state = await readDaemonState(paths);
  if (!state || !(await probeDaemon(state.host, state.port))) {
    console.log("No daemon is running. Start one with `voice-box start`.");
    return 1;
  }

  const client = new DaemonClient(state);
  const snapshot = await client.state_();

  console.log(`\nDaemon    http://${state.host}:${state.port}  pid ${state.pid}  v${state.pkgVersion}`);
  console.log(`Audio     ${snapshot.audioBackend.label}`);
  console.log(
    `Providers ${
      snapshot.providers
        .filter((provider) => provider.configured)
        .map((provider) => provider.displayName)
        .join(", ") || "none configured"
    }`,
  );

  console.log(`\nAgents (${snapshot.profiles.length})`);
  if (snapshot.profiles.length === 0) console.log("  none yet");
  for (const profile of snapshot.profiles) {
    const live = snapshot.sessions.filter((session) => session.profileId === profile.id).length;
    const flags = [profile.muted ? "muted" : null, live > 0 ? `${live} live` : "idle"]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${profile.label.padEnd(24)} ${`${profile.voice.providerId}/${profile.voice.voiceId}`.padEnd(28)} ${flags}`,
    );
    console.log(`  ${" ".repeat(24)} ${profile.projectPath}`);
  }

  const { queue } = snapshot;
  console.log(`\nQueue${queue.paused ? " (paused)" : ""}`);
  if (queue.playing) {
    console.log(`  > ${queue.playing.agentLabel}: ${queue.playing.text.slice(0, 70)}`);
  }
  if (queue.pending.length === 0 && !queue.playing) console.log("  empty");
  queue.pending.forEach((item, index) => {
    console.log(`  ${index + 1}. ${item.agentLabel}: ${item.text.slice(0, 70)}`);
  });
  console.log("");
  return 0;
}

async function logsCommand(args: string[]): Promise<number> {
  const index = args.indexOf("-n");
  const count = index === -1 ? 40 : Number(args[index + 1] ?? 40);
  try {
    const text = await readFile(getPaths().logFile, "utf8");
    const lines = text.trimEnd().split("\n");
    console.log(lines.slice(-Math.max(count, 1)).join("\n"));
    return 0;
  } catch {
    console.log("No daemon log yet.");
    return 0;
  }
}

async function speakCommand(args: string[]): Promise<number> {
  const text = args.join(" ").trim();
  if (!text) {
    console.error("Nothing to say. Usage: voice-box speak <text>");
    return 1;
  }

  const { state } = await ensureDaemon(quietLogger());
  const client = new DaemonClient(state);
  const session = await client.registerSession(deriveIdentity("voice-box-cli", PKG_VERSION));

  try {
    const response = await client.speak({
      sessionId: session.sessionId,
      text,
      wait: "played",
    });
    if (response.status === "muted") {
      console.log(`"${response.agent.name}" is muted; nothing was spoken.`);
      return 0;
    }
    console.log(`Spoke as ${response.agent.name} (${response.agent.voice}): ${response.status}`);
    if (response.warning) console.error(response.warning);
    return response.status === "played" ? 0 : 1;
  } finally {
    await client.endSession(session.sessionId).catch(() => {});
  }
}

async function keysCommand(args: string[]): Promise<number> {
  const [action, provider] = args;
  if (!action || !provider || !isProviderId(provider)) {
    console.error("Usage: voice-box keys <set|clear> <openai|elevenlabs>");
    return 1;
  }

  const store = await ConfigStore.load();
  const registry = ProviderRegistry.create(store);

  if (action === "clear") {
    await store.clearApiKey(provider);
    console.log(`Cleared the ${provider} API key.`);
    return 0;
  }
  if (action !== "set") {
    console.error("Usage: voice-box keys <set|clear> <openai|elevenlabs>");
    return 1;
  }

  // Read from stdin rather than argv so the key never reaches shell history or
  // the process list, where any other local user could read it.
  console.log(`Paste the ${provider} API key and press Enter:`);
  const key = (await readStdinLine()).trim();
  if (!key) {
    console.error("No key provided.");
    return 1;
  }

  process.stdout.write("Verifying... ");
  const verification = await registry.require(provider).verifyKey(key);
  if (!verification.ok) {
    console.error(`rejected. ${verification.detail ?? ""}`);
    return 1;
  }

  await store.setApiKey(provider, key);
  console.log("ok. Saved to ~/.voice-box/secrets.json (0600).");
  console.log("Restart the daemon to pick it up: voice-box restart");
  return 0;
}

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buffer.slice(0, newline));
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => resolve(buffer));
    process.stdin.resume();
  });
}

main(process.argv.slice(2))
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((error) => {
    const mapped: VoiceBoxError = toVoiceBoxError(error);
    console.error(`\nvoice-box: ${mapped.toDisplayString()}\n`);
    process.exit(1);
  });
