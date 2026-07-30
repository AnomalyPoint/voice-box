// Voice Box control panel — state, server sync, and user actions.
//
// One state object, fed by SSE and rendered by render.js. Transport commands
// apply their response optimistically instead of waiting for the next event --
// the old panel discarded those responses and the pause button drifted.

import { api, authenticate, reauthenticate, rememberToken } from "/api.js";
import { renderAll, renderProgress, renderSettings } from "/render.js";

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  profiles: [],
  sessions: [],
  queue: { playing: null, pending: [], paused: false, frozenMidUtterance: false, userPlayback: null },
  history: [],
  voices: {},
  providers: [],
  providerDetails: [],
  config: null,
  audio: null,
  audioBackend: null,
  daemon: null,
  selectedAgent: null,
  expanded: new Set(),
};

let eventSource = null;
let toastTimer = null;

// --- helpers ----------------------------------------------------------------

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

function banner(message, kind = "warn") {
  const el = $("#banner");
  if (!message) {
    el.hidden = true;
    return;
  }
  el.textContent = message;
  el.classList.toggle("error", kind === "error");
  el.hidden = false;
}

async function guarded(work) {
  try {
    await work();
  } catch (error) {
    toast(error?.message ?? "Something went wrong.", true);
  }
}

function profileOf(element) {
  const col = element.closest("[data-profile-id]");
  return col ? state.profiles.find((profile) => profile.id === col.dataset.profileId) : null;
}

// --- data loading -----------------------------------------------------------

async function refreshState() {
  const data = await api("GET", "/state");
  state.daemon = data.daemon;
  state.profiles = data.profiles;
  state.sessions = data.sessions;
  state.queue = data.queue;
  state.providers = data.providers;
  state.audioBackend = data.audioBackend;
}

async function refreshConfig() {
  const data = await api("GET", "/config");
  state.config = data.config;
  state.providerDetails = data.providers;
  state.audio = data.audio;
}

async function refreshHistory() {
  const data = await api("GET", "/history?limit=400");
  state.history = data.entries;
}

async function refreshVoices() {
  await Promise.all(
    state.providers
      .filter((provider) => provider.configured)
      .map(async (provider) => {
        try {
          const data = await api("GET", `/voices/${provider.id}`);
          state.voices[provider.id] = data.voices;
        } catch {
          /* voice list is cosmetic; the select falls back to "current" */
        }
      }),
  );
}

async function refreshAll() {
  await refreshState();
  await Promise.all([refreshConfig(), refreshHistory(), refreshVoices()]);
  renderAll(state);
}

// --- server-sent events -----------------------------------------------------

let sawSseError = false;
let reopenTimer = null;

function openEvents() {
  eventSource = new EventSource("/v1/events");

  eventSource.onopen = () => {
    banner(null);
    // Resync only after an actual gap -- boot already loaded everything, and
    // the server pushes a fresh snapshot on subscribe.
    if (sawSseError) {
      sawSseError = false;
      void refreshAll().catch(() => banner("Reconnecting to the daemon…"));
    }
  };

  eventSource.onerror = () => {
    sawSseError = true;
    banner("Reconnecting to the daemon…");
    // A non-200 (e.g. 401 after a cleared cookie) closes the stream for good;
    // the browser will NOT retry on its own. Re-auth and reopen ourselves.
    if (eventSource.readyState === EventSource.CLOSED && !reopenTimer) {
      reopenTimer = setTimeout(async () => {
        reopenTimer = null;
        await reauthenticate();
        openEvents();
      }, 2000);
    }
  };

  eventSource.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    state.profiles = data.profiles ?? state.profiles;
    state.sessions = data.sessions ?? state.sessions;
    state.queue = data.queue ?? state.queue;
    state.audioBackend = data.audioBackend ?? state.audioBackend;
    renderAll(state);
  });

  eventSource.addEventListener("queue", (event) => {
    const data = JSON.parse(event.data);
    state.queue = data.queue;
    if (data.profiles) state.profiles = data.profiles;
    if (data.sessions) state.sessions = data.sessions;
    renderAll(state);
  });

  eventSource.addEventListener("state", (event) => {
    const data = JSON.parse(event.data);
    if (data.profiles && data.sessions) {
      state.profiles = data.profiles;
      state.sessions = data.sessions;
      renderAll(state);
    } else {
      // Minimal payload (e.g. an agent was removed): pull the full picture.
      void refreshState()
        .then(() => renderAll(state))
        .catch(() => banner("Reconnecting to the daemon…"));
    }
  });

  eventSource.addEventListener("history", (event) => {
    const data = JSON.parse(event.data);
    if (data.cleared) {
      state.history = [];
    } else if (data.entry && !state.history.some((entry) => entry.id === data.entry.id)) {
      // The id check covers the reconnect race where the SSE replay delivers
      // an entry the resync fetch already included.
      state.history.unshift(data.entry);
      if (state.history.length > 500) state.history.length = 500;
    }
    renderAll(state);
  });

  eventSource.addEventListener("config", () => {
    void refreshConfig()
      .then(() => refreshVoices())
      .then(() => renderAll(state))
      .catch(() => banner("Reconnecting to the daemon…"));
  });
}

// --- actions ----------------------------------------------------------------

const actions = {
  "toggle-pause": async () => {
    const action = state.queue.paused ? "resume" : "pause";
    const response = await api("POST", "/queue/commands", { action });
    state.queue.paused = response.paused;
    renderAll(state);
  },

  "skip-current": async () => {
    await api("POST", "/queue/commands", { action: "skip" });
  },

  "clear-queue": async () => {
    const response = await api("POST", "/queue/commands", { action: "clear" });
    toast(
      response.cleared === 0
        ? "The queue was already empty."
        : `Cleared ${response.cleared} queued message${response.cleared === 1 ? "" : "s"}.`,
    );
  },

  "play-now": async (element) => {
    const id = element.closest(".msg")?.dataset.id;
    if (id) await api("POST", "/queue/commands", { action: "play_now", id });
  },

  "remove-queued": async (element) => {
    const id = element.closest(".msg")?.dataset.id;
    if (id) await api("POST", "/queue/commands", { action: "skip", id });
  },

  replay: async (element) => {
    const historyId = element.closest(".msg")?.dataset.historyId;
    if (!historyId) return;
    const response = await api("POST", "/replay", { historyId });
    if (response.status === "queued") {
      toast("Queued — plays right after the current message.");
    }
  },

  preview: async (element) => {
    const profile = profileOf(element);
    if (!profile) return;
    const response = await api("POST", "/preview", { voice: profile.voice });
    if (response.status === "queued") {
      toast("Preview queued — plays right after the current message.");
    }
  },

  mute: async (element) => {
    const profile = profileOf(element);
    if (!profile) return;
    const response = await api("PATCH", `/agents/${profile.id}`, { muted: !profile.muted });
    Object.assign(profile, response.profile);
    renderAll(state);
  },

  rename: (element) => startRename(element.closest(".col")),

  forget: async (element) => {
    const profile = profileOf(element);
    if (!profile) return;
    await api("DELETE", `/agents/${profile.id}`);
    state.profiles = state.profiles.filter((candidate) => candidate.id !== profile.id);
    renderAll(state);
    toast(`Forgot "${profile.label}". It will re-register if it reconnects.`);
  },

  "select-agent": (element) => {
    state.selectedAgent = element.dataset.profileId ?? null;
    renderAll(state);
  },

  "open-settings": () => {
    $("#settingsOverlay").hidden = false;
    renderSettings(state);
  },

  "close-settings": () => {
    $("#settingsOverlay").hidden = true;
  },

  "save-key": async (element) => {
    const card = element.closest(".provider-card");
    const input = $(".key-input", card);
    const key = input.value.trim();
    if (!key) {
      toast("Paste an API key first.", true);
      return;
    }
    element.disabled = true;
    try {
      await api("PUT", `/secrets/${card.dataset.provider}`, { apiKey: key });
      input.value = "";
      toast("Key verified and saved.");
      await refreshConfig();
      await refreshState();
      await refreshVoices();
      renderAll(state);
    } finally {
      element.disabled = false;
    }
  },

  "remove-key": async (element) => {
    const card = element.closest(".provider-card");
    await api("DELETE", `/secrets/${card.dataset.provider}`);
    toast("Key removed.");
    await refreshConfig();
    await refreshState();
    renderAll(state);
  },

  "clear-history": async () => {
    await api("DELETE", "/history");
    state.history = [];
    renderAll(state);
    toast("History cleared.");
  },
};

function startRename(col) {
  if (!col || col.classList.contains("editing")) return;
  const profile = state.profiles.find((candidate) => candidate.id === col.dataset.profileId);
  if (!profile) return;

  col.classList.add("editing");
  const nameEl = $(".col-name", col);
  const input = document.createElement("input");
  input.className = "col-name-input";
  input.maxLength = 60;
  input.value = profile.label;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let cancelled = false;
  const finish = async () => {
    input.removeEventListener("blur", finish);
    const label = input.value.trim();
    const span = document.createElement("span");
    span.className = "col-name";
    span.textContent = profile.label;
    input.replaceWith(span);
    col.classList.remove("editing");

    if (!cancelled && label && label !== profile.label) {
      await guarded(async () => {
        const response = await api("PATCH", `/agents/${profile.id}`, { label });
        Object.assign(profile, response.profile);
      });
    }
    renderAll(state);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      cancelled = true;
      input.blur();
    }
  });
  input.addEventListener("blur", finish);
}

// --- change handlers (selects, sliders) ------------------------------------

const debounced = new Map();
function debounce(key, fn, delayMs = 260) {
  clearTimeout(debounced.get(key));
  debounced.set(key, setTimeout(fn, delayMs));
}

function onChange(event) {
  const kind = event.target.dataset.change;
  if (!kind) return;

  if (kind === "voice") {
    const profile = profileOf(event.target);
    const [providerId, ...rest] = event.target.value.split("/");
    const voiceId = rest.join("/");
    if (!profile || !providerId || !voiceId) return;
    void guarded(async () => {
      const voice = {
        providerId,
        voiceId,
        ...(profile.voice.providerId === providerId && profile.voice.modelId !== undefined
          ? { modelId: profile.voice.modelId }
          : {}),
      };
      const response = await api("PATCH", `/agents/${profile.id}`, { voice });
      Object.assign(profile, response.profile);
      renderAll(state);
    });
  }

  if (kind === "backend") {
    void guarded(async () => {
      await api("PATCH", "/config", { audio: { backend: event.target.value } });
      toast("Saved. Restart the daemon to switch players: voice-box restart");
    });
  }
}

function onInput(event) {
  const kind = event.target.dataset.change;
  if (kind === "volume") {
    const profile = profileOf(event.target);
    if (!profile) return;
    const volume = Number(event.target.value) / 100;
    debounce(`volume:${profile.id}`, () => {
      void guarded(async () => {
        const response = await api("PATCH", `/agents/${profile.id}`, { volume });
        Object.assign(profile, response.profile);
      });
    });
  }
  if (kind === "master-volume") {
    const volume = Number(event.target.value) / 100;
    $("#masterVolumeValue").textContent = `${event.target.value}%`;
    debounce("master-volume", () => {
      void guarded(async () => {
        await api("PATCH", "/config", { audio: { volume } });
        if (state.config) state.config.audio.volume = volume;
      });
    });
  }
}

// --- click delegation -------------------------------------------------------

function onClick(event) {
  const actionEl = event.target.closest("[data-action]");
  if (actionEl) {
    const handler = actions[actionEl.dataset.action];
    if (handler) void guarded(() => handler(actionEl));
    return;
  }

  const nowText = event.target.closest("#nowText");
  if (nowText && !nowText.classList.contains("idle")) {
    nowText.classList.toggle("expanded");
    return;
  }

  const msg = event.target.closest(".msg");
  if (msg) {
    const key = msg.dataset.historyId ?? msg.dataset.id;
    if (!key) return;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    msg.classList.toggle("expanded");
    return;
  }

  if (event.target === $("#settingsOverlay")) actions["close-settings"]();
}

// --- boot -------------------------------------------------------------------

async function boot() {
  // Trade the fragment token for the auth cookie, then wipe it from the URL
  // (and keep it for self-healing after an expired cookie).
  const match = /[#&]t=([^&]+)/.exec(location.hash);
  if (match) {
    const token = decodeURIComponent(match[1]);
    // Remember only a token that works: a stale bookmarked link must not
    // clobber a good remembered token.
    if (await authenticate(token)) rememberToken(token);
    history.replaceState(null, "", location.pathname);
  }

  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#settingsOverlay").hidden) actions["close-settings"]();
  });

  try {
    await refreshAll();
  } catch (error) {
    if (error?.status === 401) {
      banner(
        "This browser isn't signed in. Run `voice-box start` in a terminal and open the panel link it prints (it carries the sign-in key).",
        "error",
      );
      return;
    }
    banner(`Cannot reach the daemon: ${error?.message ?? "unknown error"}`, "error");
    return;
  }

  openEvents();
  setInterval(() => renderProgress(state), 500);
}

void boot();
