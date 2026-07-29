/**
 * Control panel entry point.
 *
 * Flow: trade the URL-fragment token for a cookie, load state, subscribe to
 * server-sent events, then re-render the visible panel on every change.
 */
import { api, ApiError, establishSession } from "./api.js";
import { renderChannels, renderCue, renderDiag, renderLog, renderSetup } from "./views.js";

const state = {
  profiles: [],
  sessions: [],
  queue: { playing: null, pending: [], paused: false },
  providers: [],
  config: { audio: { backend: "auto", volume: 1 } },
  audio: { selected: {}, available: [], missing: [] },
  voices: {},
  history: [],
  meta: { host: location.hostname, port: location.port, pid: "—", version: "—" },
};

let activeTab = "channels";
let toastTimer;

// --- Boot ------------------------------------------------------------------

async function boot() {
  try {
    await establishSession();
  } catch {
    // A stale or missing fragment is fine if a valid cookie is already set.
  }

  try {
    await Promise.all([loadState(), loadConfig(), loadHistory()]);
    await loadVoices();
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_input") {
      showFatal("This page is not authorised. Re-open the panel with `voice-box`.");
      return;
    }
    toast(describe(error), "error");
  }

  renderAll();
  connectEvents();
  wireEvents();
}

async function loadState() {
  const data = await api("GET", "/state");
  state.profiles = data.profiles;
  state.sessions = data.sessions;
  state.queue = data.queue;
  state.audio.selected = data.audioBackend;
  if (data.daemon) {
    state.meta = {
      host: data.daemon.host,
      port: data.daemon.port,
      pid: data.daemon.pid,
      version: data.daemon.version,
    };
  }
}

async function loadConfig() {
  const data = await api("GET", "/config");
  state.config = data.config;
  state.providers = data.providers;
  state.audio = { ...state.audio, ...data.audio };
}

async function loadHistory() {
  state.history = (await api("GET", "/history")).entries;
}

/** Voice catalogues, fetched only for providers that actually have a key. */
async function loadVoices() {
  for (const provider of state.providers) {
    if (!provider.configured) continue;
    try {
      const data = await api("GET", `/voices/${provider.providerId}`);
      state.voices[provider.providerId] = data.voices;
    } catch {
      // ElevenLabs needs the network for this; a failure must not break the page.
      state.voices[provider.providerId] = [];
    }
  }
}

// --- Live updates ----------------------------------------------------------

function connectEvents() {
  const source = new EventSource("/v1/events");

  source.addEventListener("open", () => setLamp("live", "live"));
  source.addEventListener("error", () => setLamp("down", "reconnecting"));

  const applyQueue = (event) => {
    const data = JSON.parse(event.data);
    if (data.queue) state.queue = data.queue;
    if (data.profiles) state.profiles = data.profiles;
    if (data.sessions) state.sessions = data.sessions;
    renderAll();
  };

  source.addEventListener("snapshot", applyQueue);
  source.addEventListener("queue", applyQueue);
  source.addEventListener("state", () => void loadState().then(renderAll));
  source.addEventListener("config", () => void loadConfig().then(renderAll));
  source.addEventListener("history", () => void loadHistory().then(renderAll));
}

function setLamp(lampState, label) {
  document.getElementById("conn-lamp").dataset.state = lampState;
  document.getElementById("conn-label").textContent = label;
}

// --- Rendering -------------------------------------------------------------

function renderAll() {
  renderTransport();

  const panels = {
    channels: () => renderChannels(document.getElementById("channels"), state),
    cue: () => renderCue(document.getElementById("cue"), state),
    log: () => renderLog(document.getElementById("log"), state),
    setup: () => renderSetup(document.getElementById("setup"), state),
    diag: () => renderDiag(document.getElementById("diag"), state),
  };
  panels[activeTab]();

  document.getElementById("daemon-addr").textContent = `${location.hostname}:${location.port}`;
  document.getElementById("daemon-version").textContent = state.meta.version;
}

function renderTransport() {
  const playing = state.queue.playing;
  const box = document.getElementById("now-playing");
  box.dataset.active = String(Boolean(playing));

  document.getElementById("now-agent").textContent = playing ? playing.agentLabel : "idle";
  document.getElementById("now-line").textContent = playing
    ? playing.text
    : state.queue.paused
      ? "paused"
      : "nothing queued";
  document.getElementById("queue-count").textContent = String(state.queue.pending.length);

  const paused = state.queue.paused;
  const button = document.getElementById("pause-btn");
  button.setAttribute("aria-pressed", String(paused));
  document.getElementById("pause-glyph").textContent = paused ? "▶" : "II";
  document.getElementById("pause-label").textContent = paused ? "RESUME" : "PAUSE";
}

// --- Interaction -----------------------------------------------------------

function wireEvents() {
  document.querySelector(".tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    activeTab = tab.dataset.tab;
    for (const node of document.querySelectorAll(".tab")) {
      node.classList.toggle("is-active", node === tab);
    }
    for (const panel of document.querySelectorAll("[data-view]")) {
      panel.hidden = panel.dataset.view !== activeTab;
    }
    renderAll();
  });

  document.body.addEventListener("click", onClick);
  document.body.addEventListener("change", onChange);
  document.body.addEventListener("input", onInput);
}

async function onClick(event) {
  const target = event.target.closest("button");
  if (!target) return;

  const channel = target.closest(".channel");
  const profileId = channel && channel.dataset.id;
  const action = target.dataset.action || target.dataset.role;

  try {
    switch (action) {
      case "toggle-pause":
        await command({ action: state.queue.paused ? "resume" : "pause" });
        break;
      case "skip":
        if (target.closest(".cue-row")) {
          await command({ action: "skip", id: target.closest(".cue-row").dataset.id });
        } else {
          await command({ action: "skip" });
        }
        break;
      case "clear":
        await command({ action: "clear" });
        toast("Queue cleared.");
        break;
      case "mute": {
        const profile = state.profiles.find((entry) => entry.id === profileId);
        await patchAgent(profileId, { muted: !profile.muted });
        break;
      }
      case "remove":
        await api("DELETE", `/agents/${profileId}`);
        toast("Agent forgotten.");
        await loadState();
        renderAll();
        break;
      case "preview": {
        const select = channel.querySelector('[data-role="voice"]');
        target.disabled = true;
        try {
          await api("POST", "/preview", { voice: parseVoice(select.value) });
        } finally {
          target.disabled = false;
        }
        break;
      }
      case "name":
        beginRename(target, profileId);
        break;
      case "replay":
        if (target.dataset.key) new Audio(`/v1/audio/${target.dataset.key}`).play();
        break;
      case "save-key":
        await saveKey(target.closest(".card"));
        break;
      case "clear-key": {
        const provider = target.closest(".card").dataset.provider;
        await api("DELETE", `/secrets/${provider}`);
        toast("Key removed.");
        await refreshConfig();
        break;
      }
      case "clear-history":
        await api("DELETE", "/history");
        await loadHistory();
        renderAll();
        break;
      default:
        break;
    }
  } catch (error) {
    toast(describe(error), "error");
  }
}

async function onChange(event) {
  const target = event.target;
  try {
    if (target.dataset.role === "voice") {
      const profileId = target.closest(".channel").dataset.id;
      await patchAgent(profileId, { voice: parseVoice(target.value) });
      toast("Voice assigned. Agents cannot override it.");
    } else if (target.dataset.action === "set-backend") {
      await api("PATCH", "/config", { audio: { backend: target.value } });
      toast("Restart the daemon to switch player: voice-box restart");
    }
  } catch (error) {
    toast(describe(error), "error");
  }
}

/** Sliders fire continuously; only persist once the user settles. */
const debounced = new Map();
function onInput(event) {
  const target = event.target;
  if (target.type !== "range") return;

  const channel = target.closest(".channel");
  if (channel) {
    const value = channel.querySelector('[data-role="volume-value"]');
    if (value) value.textContent = target.value;
    schedule(`agent:${channel.dataset.id}`, () =>
      patchAgent(channel.dataset.id, { volume: Number(target.value) / 100 }),
    );
  } else if (target.dataset.action === "set-master-volume") {
    const label = target.nextElementSibling;
    if (label) label.textContent = `master ${target.value}`;
    schedule("master", () =>
      api("PATCH", "/config", { audio: { volume: Number(target.value) / 100 } }),
    );
  }
}

function schedule(key, run) {
  clearTimeout(debounced.get(key));
  debounced.set(
    key,
    setTimeout(() => {
      run().catch((error) => toast(describe(error), "error"));
    }, 260),
  );
}

function beginRename(button, profileId) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = button.textContent;
  input.className = "channel-name";
  input.maxLength = 60;
  button.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const label = input.value.trim();
    input.replaceWith(button);
    if (!label || label === button.textContent) return;
    try {
      await patchAgent(profileId, { label });
      button.textContent = label;
    } catch (error) {
      toast(describe(error), "error");
    }
  };

  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      input.value = button.textContent;
      input.blur();
    }
  });
}

async function saveKey(card) {
  const provider = card.dataset.provider;
  const input = card.querySelector('[data-role="key-input"]');
  const apiKey = input.value.trim();
  if (!apiKey) {
    toast("Paste a key first.", "error");
    return;
  }

  const button = card.querySelector('[data-action="save-key"]');
  button.disabled = true;
  button.textContent = "verifying…";
  try {
    // The daemon checks the key against the provider before saving it, so a
    // typo fails here rather than silently later.
    const result = await api("PUT", `/secrets/${provider}`, { apiKey });
    input.value = "";
    toast(`Saved ${result.hint}.`);
    await refreshConfig();
  } finally {
    button.disabled = false;
    button.textContent = "verify & save";
  }
}

async function refreshConfig() {
  await loadConfig();
  await loadVoices();
  renderAll();
}

// --- Helpers ---------------------------------------------------------------

const command = (body) => api("POST", "/queue/commands", body);

async function patchAgent(profileId, patch) {
  await api("PATCH", `/agents/${profileId}`, patch);
  await loadState();
  renderAll();
}

function parseVoice(value) {
  const [providerId, ...rest] = value.split("/");
  return { providerId, voiceId: rest.join("/") };
}

function describe(error) {
  if (error instanceof ApiError) return error.hint ? `${error.message} ${error.hint}` : error.message;
  return error && error.message ? error.message : String(error);
}

function toast(message, kind) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.dataset.kind = kind || "info";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

function showFatal(message) {
  setLamp("down", "unauthorised");
  const main = document.querySelector("main");
  main.replaceChildren();
  const box = document.createElement("div");
  box.className = "empty";
  box.textContent = message;
  main.append(box);
}

boot();
