// Pure-ish render layer: (state) -> DOM. No fetching, no business logic.
//
// Columns are keyed by profileId and updated in place so open selects, range
// drags, and rename inputs survive re-renders. Message cards are cheap and
// rebuilt wholesale; expansion state lives in state.expanded and is re-applied.

const $ = (selector, root = document) => root.querySelector(selector);

const tplColumn = $("#tpl-column");
const tplQueueCard = $("#tpl-queue-card");
const tplPlayingCard = $("#tpl-playing-card");
const tplHistoryCard = $("#tpl-history-card");
const tplChip = $("#tpl-chip");
const tplProviderCard = $("#tpl-provider-card");

const columnEls = new Map();

// --- formatters -------------------------------------------------------------

export function timeOf(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function estimateSeconds(text) {
  return Math.max(1, Math.round(text.length / 14));
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function shortPath(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

// --- transport --------------------------------------------------------------

export function renderTransport(state) {
  const { queue } = state;
  const playing = queue.playing;
  const user = queue.userPlayback;

  document.body.classList.toggle("paused", queue.paused);
  document.body.classList.toggle("replaying", Boolean(user));
  document.body.classList.toggle("playing", !queue.paused && !user && Boolean(playing));

  const word = $("#stateWord");
  if (queue.paused && user) word.textContent = "REPLAY";
  else if (queue.paused) word.textContent = "PAUSED";
  else if (user) word.textContent = "REPLAY";
  else if (playing?.status === "synthesizing") word.textContent = "PREPARING";
  else if (playing) word.textContent = "PLAYING";
  else word.textContent = "IDLE";

  const agentEl = $("#nowAgent");
  const textEl = $("#nowText");
  if (user) {
    agentEl.textContent = user.label.toUpperCase();
    agentEl.style.color = "var(--blue)";
    textEl.textContent = user.text;
    textEl.classList.remove("idle");
  } else if (playing) {
    const profile = state.profiles.find((candidate) => candidate.id === playing.profileId);
    agentEl.textContent = playing.agentLabel.toUpperCase();
    agentEl.style.color = profile?.color ?? "var(--text-dim)";
    textEl.textContent = playing.text;
    textEl.classList.remove("idle");
  } else {
    agentEl.textContent = "";
    textEl.textContent = queue.paused ? "Paused." : "Nothing is playing.";
    textEl.classList.add("idle");
    textEl.classList.remove("expanded");
  }

  $("#pausedNote").hidden = !queue.paused;
  $("#pauseLbl").textContent = queue.paused ? "RESUME" : "PAUSE";
  $("#pauseIcon").firstElementChild?.setAttribute(
    "href",
    queue.paused ? "#i-play" : "#i-pause",
  );

  const count = queue.pending.length;
  $("#queueCount").innerHTML = "";
  const bold = document.createElement("b");
  bold.textContent = String(count);
  $("#queueCount").append(bold, ` queued`);

  renderProgress(state);
}

/** Called by the ticker too, between full renders. */
export function renderProgress(state) {
  const playing = state.queue.playing;
  const fill = $("#progressFill");
  const timeEl = $("#stateTime");

  if (!playing || playing.status !== "playing" || !playing.startedAt) {
    fill.style.width = state.queue.userPlayback ? "100%" : "0%";
    timeEl.textContent = "";
    return;
  }
  const total = estimateSeconds(playing.text);
  // Freeze the clock at the moment of pause; snapping to 0 would lie.
  const raw = (Date.now() - Date.parse(playing.startedAt)) / 1000;
  let elapsed;
  if (state.queue.paused) {
    if (state._frozenElapsed === undefined) state._frozenElapsed = raw;
    elapsed = state._frozenElapsed;
  } else {
    state._frozenElapsed = undefined;
    elapsed = raw;
  }
  const pct = Math.min(96, (elapsed / total) * 100);
  fill.style.width = `${pct}%`;
  timeEl.textContent = `${formatClock(Math.min(elapsed, total))} / ~${formatClock(total)}`;
}

// --- agent chip bar (narrow screens) ---------------------------------------

export function renderChips(state) {
  const bar = $("#chipBar");
  bar.innerHTML = "";
  const ordered = orderedProfiles(state);
  bar.hidden = ordered.length === 0;
  if (ordered.length > 0) bar.dataset.hasAgents = "1";
  else delete bar.dataset.hasAgents;

  for (const profile of ordered) {
    const chip = tplChip.content.firstElementChild.cloneNode(true);
    chip.dataset.profileId = profile.id;
    chip.classList.toggle("active", profile.id === state.selectedAgent);
    chip.classList.toggle("offline", !isLive(state, profile.id));
    $(".cdot", chip).style.color = profile.color;
    $(".chip-name", chip).textContent = profile.label;
    const pendingCount = state.queue.pending.filter(
      (item) => item.profileId === profile.id,
    ).length;
    const n = $(".chip-n", chip);
    n.hidden = pendingCount === 0;
    n.textContent = String(pendingCount);
    bar.append(chip);
  }
}

// --- columns ----------------------------------------------------------------

function isLive(state, profileId) {
  return state.sessions.some((session) => session.profileId === profileId);
}

function orderedProfiles(state) {
  return [...state.profiles].sort((a, b) => {
    const liveA = isLive(state, a.id) ? 1 : 0;
    const liveB = isLive(state, b.id) ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
  });
}

export function renderDeck(state) {
  const deck = $("#deck");
  const hero = $("#emptyHero");
  const ordered = orderedProfiles(state);

  hero.hidden = ordered.length > 0;
  $("#heroHint").hidden = state.providers.some((provider) => provider.configured);

  // Keep the mobile selection valid.
  if (!ordered.some((profile) => profile.id === state.selectedAgent)) {
    state.selectedAgent = ordered[0]?.id ?? null;
  }

  const seen = new Set();
  let previous = hero;
  for (const profile of ordered) {
    let el = columnEls.get(profile.id);
    if (!el) {
      el = tplColumn.content.firstElementChild.cloneNode(true);
      el.dataset.profileId = profile.id;
      columnEls.set(profile.id, el);
    }
    // Maintain document order to match `ordered`.
    if (el.previousElementSibling !== previous || el.parentElement !== deck) {
      previous.after(el);
    }
    previous = el;
    seen.add(profile.id);
    updateColumn(el, profile, state);
  }

  for (const [profileId, el] of columnEls) {
    if (!seen.has(profileId)) {
      el.remove();
      columnEls.delete(profileId);
    }
  }
}

function updateColumn(el, profile, state) {
  const live = isLive(state, profile.id);
  const playing = state.queue.playing;
  const isSpeaking = playing?.profileId === profile.id;

  el.classList.toggle("offline-col", !live);
  el.classList.toggle("muted-col", profile.muted);
  el.classList.toggle("selected-col", profile.id === state.selectedAgent);

  const dot = $(".agent-dot", el);
  dot.className = `agent-dot ${live ? "live" : "offline"}`;
  dot.style.color = profile.color;

  if (!el.classList.contains("editing")) {
    $(".col-name", el).textContent = profile.label;
  }

  const status = $(".col-status", el);
  if (!live) status.textContent = `OFFLINE · ${ago(profile.lastSeen).toUpperCase()}`;
  else if (profile.muted) status.textContent = "MUTED";
  else if (isSpeaking) status.textContent = "SPEAKING";
  else status.textContent = "";

  $(".forget-btn", el).hidden = live;
  const path = $(".col-path", el);
  path.textContent = shortPath(profile.projectPath);
  path.title = profile.projectPath;

  updateVoiceSelect($(".voice-select", el), profile, state);

  const muteBtn = $(".mute-btn", el);
  muteBtn.classList.toggle("active", profile.muted);
  muteBtn.title = profile.muted ? "Unmute this agent" : "Mute this agent";
  muteBtn.firstElementChild.firstElementChild.setAttribute(
    "href",
    profile.muted ? "#i-mute" : "#i-speaker",
  );

  const volume = $(".col-volume input", el);
  if (document.activeElement !== volume) volume.value = String(Math.round(profile.volume * 100));

  // Queue section: the playing card (if this agent is speaking) plus its
  // pending items, each stamped with its global play position.
  const queueSection = $(".queue-section", el);
  const queueStack = $(".queue-stack", el);
  queueStack.innerHTML = "";

  if (isSpeaking) {
    const card = tplPlayingCard.content.firstElementChild.cloneNode(true);
    card.dataset.id = playing.id;
    if (playing.status === "synthesizing") {
      $(".badge-word", card).textContent = "PREPARING";
    } else if (state.queue.paused) {
      $(".badge-word", card).textContent = state.queue.frozenMidUtterance
        ? "PAUSED MID-WORD"
        : "PAUSED";
    }
    setCardText(card, playing.text, state);
    queueStack.append(card);
  }

  state.queue.pending.forEach((item, index) => {
    if (item.profileId !== profile.id) return;
    const card = tplQueueCard.content.firstElementChild.cloneNode(true);
    card.dataset.id = item.id;
    const badge = $(".order-badge", card);
    badge.textContent = `QUEUED #${index + 1} · ~${formatClock(estimateSeconds(item.text))}`;
    if (item.priority !== "normal") badge.textContent += ` · ${item.priority.toUpperCase()}`;
    setCardText(card, item.text, state);
    queueStack.append(card);
  });

  queueSection.hidden = queueStack.children.length === 0;

  // History: newest first, this agent only.
  const entries = state.history
    .filter((entry) => entry.profileId === profile.id)
    .slice(0, 50);
  const historyStack = $(".history-stack", el);
  historyStack.innerHTML = "";
  $(".history-section .empty-note", el).hidden = entries.length > 0;

  for (const entry of entries) {
    historyStack.append(historyCard(entry, state));
  }
}

const HISTORY_BADGES = {
  failed: ["failed", "FAILED"],
  skipped: ["skipped", "SKIPPED BY YOU"],
  expired: ["skipped", "EXPIRED"],
  dropped: ["skipped", "DROPPED"],
  muted: ["skipped", "MUTED"],
  degraded: ["failed", "NO AUDIO"],
};

function historyCard(entry, state) {
  const card = tplHistoryCard.content.firstElementChild.cloneNode(true);
  card.dataset.historyId = entry.id;
  $(".msg-time", card).textContent = timeOf(entry.at);

  const badgeSpec = HISTORY_BADGES[entry.status];
  const badge = $(".status-badge", card);
  if (badgeSpec) {
    badge.hidden = false;
    badge.classList.add(badgeSpec[0]);
    badge.textContent = badgeSpec[1];
  }

  if (entry.status === "failed" || entry.status === "degraded") {
    $(".replay-btn", card).remove();
    if (entry.detail) {
      const sub = $(".msg-sub", card);
      sub.hidden = false;
      const fail = document.createElement("span");
      fail.className = "fail";
      fail.textContent = entry.detail;
      sub.append(fail, " — audio was never played");
    }
  }

  setCardText(card, entry.text, state, entry.id);
  return card;
}

function setCardText(card, text, state, key) {
  const el = $(".msg-text", card);
  el.textContent = text;
  el.title = "Click to expand";
  const id = key ?? card.dataset.id;
  if (id && state.expanded.has(id)) card.classList.add("expanded");
}

// --- settings ---------------------------------------------------------------

export function renderSettings(state) {
  const overlay = $("#settingsOverlay");
  if (overlay.hidden) return;

  const cards = $("#providerCards");
  // Never yank the DOM out from under someone TYPING a key -- but a focused
  // button must not block the rebuild, or saving a key never updates the card.
  if (!document.activeElement?.classList?.contains("key-input")) {
    cards.innerHTML = "";
    for (const provider of state.providerDetails ?? []) {
      const card = tplProviderCard.content.firstElementChild.cloneNode(true);
      card.dataset.provider = provider.providerId;
      $(".provider-name", card).textContent = provider.displayName;
      const badge = $(".provider-state", card);
      badge.classList.add(provider.configured ? "ok" : "skipped");
      badge.textContent = provider.configured ? "CONFIGURED" : "NO KEY";
      $(".provider-hint", card).textContent = provider.configured
        ? `${provider.hint ?? ""}${provider.source === "env" ? ` · from ${provider.envVar}` : ""}`
        : `or set ${provider.envVar}`;
      $(".remove-key-btn", card).hidden = !provider.configured || provider.source === "env";
      cards.append(card);
    }
  }

  const backendSelect = $("#backendSelect");
  if (document.activeElement !== backendSelect && state.audio) {
    backendSelect.innerHTML = "";
    for (const entry of state.audio.available) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label;
      backendSelect.append(option);
    }
    const selectedId = state.config?.audio.backend ?? state.audio.selected?.id;
    if (selectedId && [...backendSelect.options].some((option) => option.value === selectedId)) {
      backendSelect.value = selectedId;
    }
  }

  const master = $("#masterVolume");
  const masterValue = Math.round((state.config?.audio.volume ?? 1) * 100);
  if (document.activeElement !== master) master.value = String(masterValue);
  $("#masterVolumeValue").textContent = `${masterValue}%`;

  $("#audioNote").textContent =
    state.audio && state.audio.missing.length > 0
      ? `Switching players needs a daemon restart (voice-box restart). Not installed: ${state.audio.missing
          .map((entry) => entry.id ?? entry)
          .join(", ")}.`
      : "Switching players needs a daemon restart (voice-box restart).";

  if (state.daemon) {
    $("#daemonInfo").textContent =
      `${state.daemon.host}:${state.daemon.port} · v${state.daemon.version} · ` +
      `audio: ${state.audioBackend?.label ?? "?"} · pid ${state.daemon.pid}`;
  }
}

function updateVoiceSelect(select, profile, state) {
  if (document.activeElement === select) return;

  const current = `${profile.voice.providerId}/${profile.voice.voiceId}`;
  select.innerHTML = "";
  let found = false;

  for (const provider of state.providers) {
    if (!provider.configured) continue;
    const voices = state.voices[provider.id] ?? [];
    if (voices.length === 0) continue;
    const group = document.createElement("optgroup");
    group.label = provider.displayName;
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = `${voice.providerId}/${voice.voiceId}`;
      option.textContent = voice.label;
      if (option.value === current) found = true;
      group.append(option);
    }
    select.append(group);
  }

  if (!found) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = `${profile.voice.voiceId} (current)`;
    select.prepend(option);
  }
  select.value = current;
}

export function renderAll(state) {
  renderTransport(state);
  renderChips(state);
  renderDeck(state);
  renderSettings(state);
}
