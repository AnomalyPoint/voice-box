/**
 * Render functions. Each takes the current state and paints one panel.
 *
 * Markup comes from <template> elements in index.html rather than string
 * literals, so the structure stays reviewable and there is no innerHTML path
 * for text that originates from an agent.
 *
 * All dynamic styling goes through CSSOM (el.style.x = ...). Note that
 * setAttribute("style", ...) would be blocked by the page's CSP, which forbids
 * inline style attributes; CSSOM writes are not.
 */

const tpl = (id) => document.getElementById(id).content.firstElementChild;

/**
 * Shorten a long path from the front. The tail is the meaningful part, and a
 * CSS `direction: rtl` trick would relocate the leading slash ("/home/dev"
 * renders as "home/dev/"), so do it explicitly.
 */
function shortPath(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

const fmtTime = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

function emptyNote(message) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = message;
  return div;
}

// --- Channels --------------------------------------------------------------

export function renderChannels(root, state) {
  root.replaceChildren();

  if (!state.profiles.length) {
    root.append(
      emptyNote("No agents yet. Point an MCP client at Voice Box and ask it to speak."),
    );
    return;
  }

  const liveByProfile = new Set(state.sessions.map((session) => session.profileId));

  state.profiles.forEach((profile, index) => {
    const node = tpl("tpl-channel").cloneNode(true);
    const pick = (role) => node.querySelector(`[data-role="${role}"]`);

    node.dataset.id = profile.id;
    node.classList.toggle("is-muted", profile.muted);
    node.classList.toggle("is-live", liveByProfile.has(profile.id));
    // Staggered reveal; capped so a long roster does not crawl in.
    node.style.animationDelay = `${Math.min(index, 8) * 26}ms`;

    const chip = pick("chip");
    chip.style.background = profile.color;
    chip.style.color = profile.color;

    pick("name").textContent = profile.label;
    const project = pick("project");
    project.textContent = shortPath(profile.projectPath);
    project.title = profile.projectPath;

    const select = pick("voice");
    fillVoiceOptions(select, state, profile.voice);

    const volume = pick("volume");
    volume.value = String(Math.round(profile.volume * 100));
    pick("volume-value").textContent = `${Math.round(profile.volume * 100)}`;

    const mute = pick("mute");
    mute.setAttribute("aria-pressed", String(profile.muted));

    root.append(node);
  });
}

function fillVoiceOptions(select, state, current) {
  select.replaceChildren();
  const currentKey = `${current.providerId}/${current.voiceId}`;
  let matched = false;

  for (const provider of state.providers.filter((entry) => entry.configured)) {
    const voices = state.voices[provider.providerId] || [];
    if (!voices.length) continue;

    const group = document.createElement("optgroup");
    group.label = provider.displayName;
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = `${voice.providerId}/${voice.voiceId}`;
      option.textContent = voice.label;
      if (option.value === currentKey) {
        option.selected = true;
        matched = true;
      }
      group.append(option);
    }
    select.append(group);
  }

  // The assigned voice may belong to a provider whose key was removed; show it
  // anyway so the user can see what is actually configured.
  if (!matched) {
    const option = document.createElement("option");
    option.value = currentKey;
    option.textContent = `${current.voiceId} (unavailable)`;
    option.selected = true;
    select.prepend(option);
  }
}

// --- Cue -------------------------------------------------------------------

export function renderCue(root, state) {
  root.replaceChildren();

  const { playing, pending } = state.queue;
  if (!playing && !pending.length) {
    root.append(emptyNote("Queue is empty."));
    return;
  }

  const colors = new Map(state.profiles.map((profile) => [profile.id, profile.color]));
  const list = document.createElement("ul");
  list.className = "rows";

  const rows = [];
  if (playing) rows.push({ item: playing, playing: true });
  pending.forEach((item, index) => rows.push({ item, playing: false, position: index + 1 }));

  let etaSeconds = 0;
  for (const row of rows) {
    const node = tpl("tpl-cue-row").cloneNode(true);
    const pick = (role) => node.querySelector(`[data-role="${role}"]`);

    node.dataset.id = row.item.id;
    node.classList.toggle("is-playing", row.playing);

    pick("pos").textContent = row.playing ? "▶" : String(row.position);
    const chip = pick("chip");
    chip.style.background = colors.get(row.item.profileId) || "var(--dim)";
    pick("agent").textContent = row.item.agentLabel;
    pick("text").textContent = row.item.text;
    pick("text").title = row.item.text;
    pick("eta").textContent = row.playing ? "now" : `~${etaSeconds}s`;

    // Same ~14 chars/second estimate the daemon uses for its own ETAs.
    etaSeconds += Math.round(row.item.text.length / 14);
    list.append(node);
  }

  root.append(list);
}

// --- Log -------------------------------------------------------------------

export function renderLog(root, state) {
  root.replaceChildren();

  if (!state.history.length) {
    root.append(emptyNote("Nothing spoken yet."));
    return;
  }

  const list = document.createElement("ul");
  list.className = "rows";

  for (const entry of state.history) {
    const node = tpl("tpl-log-row").cloneNode(true);
    const pick = (role) => node.querySelector(`[data-role="${role}"]`);

    pick("time").textContent = fmtTime(entry.at);
    pick("agent").textContent = entry.agentLabel;
    pick("text").textContent = entry.text;
    pick("text").title = `${entry.text}\n${entry.voice}`;

    const status = pick("status");
    status.textContent = entry.status;
    status.dataset.status = entry.status;

    const replay = pick("replay");
    if (entry.audioKey) {
      replay.dataset.key = entry.audioKey;
    } else {
      replay.remove();
    }
    list.append(node);
  }

  root.append(list);
}

// --- Setup -----------------------------------------------------------------

export function renderSetup(root, state) {
  root.replaceChildren();

  for (const provider of state.providers) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.provider = provider.providerId;

    const title = document.createElement("h3");
    title.textContent = provider.displayName;

    const line = document.createElement("div");
    line.className = "state-line";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset.on = String(provider.configured);
    badge.textContent = provider.configured ? "configured" : "not configured";
    line.append(badge);

    if (provider.configured) {
      const hint = document.createElement("span");
      // Only ever a masked hint -- the daemon never sends the real key.
      hint.textContent = `${provider.hint} (from ${provider.source})`;
      line.append(hint);
    }

    const note = document.createElement("p");
    note.textContent =
      provider.source === "env"
        ? `Set by the ${provider.envVar} environment variable, which takes precedence over anything saved here.`
        : `Stored in ~/.voice-box/secrets.json with 0600 permissions. ${provider.envVar} overrides it.`;

    const field = document.createElement("div");
    field.className = "field";
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = `${provider.displayName} API key`;
    input.autocomplete = "off";
    input.dataset.role = "key-input";
    const save = document.createElement("button");
    save.className = "ghost";
    save.dataset.action = "save-key";
    save.textContent = "verify & save";
    field.append(input, save);

    if (provider.configured && provider.source === "file") {
      const clear = document.createElement("button");
      clear.className = "ghost";
      clear.dataset.action = "clear-key";
      clear.textContent = "remove";
      field.append(clear);
    }

    card.append(title, line, note, field);
    root.append(card);
  }

  root.append(audioCard(state));
}

function audioCard(state) {
  const card = document.createElement("div");
  card.className = "card";

  const title = document.createElement("h3");
  title.textContent = "Audio output";

  const note = document.createElement("p");
  note.textContent =
    "Voice Box plays MP3 through a player already on your system, so there is nothing to compile and ffmpeg is optional.";

  const field = document.createElement("div");
  field.className = "field";

  const select = document.createElement("select");
  select.dataset.action = "set-backend";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "auto (first available)";
  select.append(auto);
  for (const backend of state.audio.available) {
    const option = document.createElement("option");
    option.value = backend.id;
    option.textContent = backend.label;
    select.append(option);
  }
  select.value = state.config.audio.backend;

  const volumeLabel = document.createElement("label");
  volumeLabel.className = "channel-level";
  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "100";
  volume.step = "5";
  volume.value = String(Math.round(state.config.audio.volume * 100));
  volume.dataset.action = "set-master-volume";
  const volumeValue = document.createElement("span");
  volumeValue.textContent = `master ${Math.round(state.config.audio.volume * 100)}`;
  volumeLabel.append(volume, volumeValue);

  field.append(select, volumeLabel);
  card.append(title, note, field);
  return card;
}

// --- Diagnostics -----------------------------------------------------------

export function renderDiag(root, state) {
  root.replaceChildren();

  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "Diagnostics";

  const list = document.createElement("dl");
  list.className = "kv";

  const rows = [
    ["daemon", `${state.meta.host}:${state.meta.port}  pid ${state.meta.pid}`],
    ["version", state.meta.version],
    ["audio backend", `${state.audio.selected.label}`],
    ["executable", state.audio.selected.executable || "none"],
    ["players found", state.audio.available.map((entry) => entry.id).join(", ") || "none"],
    ["players missing", state.audio.missing.map((entry) => entry.id).join(", ") || "none"],
    ["agents", String(state.profiles.length)],
    ["live sessions", String(state.sessions.length)],
    ["queue depth", String(state.queue.pending.length)],
  ];

  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }

  card.append(title, list);
  root.append(card);

  if (state.audio.missing.length) {
    const hints = document.createElement("div");
    hints.className = "card";
    const hintsTitle = document.createElement("h3");
    hintsTitle.textContent = "Optional players";
    hints.append(hintsTitle);
    for (const entry of state.audio.missing) {
      if (!entry.installHint) continue;
      const line = document.createElement("p");
      line.textContent = `${entry.label} — ${entry.installHint}`;
      hints.append(line);
    }
    root.append(hints);
  }
}
