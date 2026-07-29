# Voice Box

[![npm version](https://img.shields.io/npm/v/@anomalypoint/voice-box.svg)](https://www.npmjs.com/package/@anomalypoint/voice-box)
[![npm downloads](https://img.shields.io/npm/dm/@anomalypoint/voice-box.svg)](https://www.npmjs.com/package/@anomalypoint/voice-box)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A local voice control panel for AI coding agents.**

Voice Box lets Claude Code, Cursor, Claude Desktop and other MCP clients talk to you out
loud — and gives you a control panel to manage them. Each agent gets its own voice, every
utterance goes through one queue so agents never talk over each other, and you can mute,
skip, or reassign any of them from a browser tab.

Everything runs on your machine. The only thing that leaves it is the text you choose to
have spoken, sent to whichever TTS provider you configured.

---

## Why

Running several agents at once means several voices at once. Voice Box puts a single
daemon in charge of the speaker: agents register with it, their messages are queued
fairly, and you stay in control of who sounds like what.

- **No native dependencies.** Nothing compiles at install time.
- **No ffmpeg required.** Audio plays through a player your OS already has.
- **Multi-agent by design.** One playback lane, round-robin fairness, per-agent mute.
- **Two providers.** OpenAI TTS and ElevenLabs, chosen per agent.
- **Keys in one place.** Not duplicated into every project's MCP config.

---

## Requirements

- **Node.js 18.17+**
- **An audio player** — already present on virtually every system:
  - macOS: `afplay` (built in, nothing to do)
  - Windows: PowerShell (built in, nothing to do)
  - Linux: one of `ffplay`, `mpg123`, `mpv`, or `cvlc` — e.g. `sudo apt install mpg123`
- **An API key** for [OpenAI](https://platform.openai.com/api-keys) or
  [ElevenLabs](https://elevenlabs.io/app/settings/api-keys)

Run `npx @anomalypoint/voice-box doctor` to check all of this at once.

---

## Quick start

**1. Open the control panel.** This starts the daemon and opens your browser:

```bash
npx @anomalypoint/voice-box
```

**2. Add an API key** in the **SETUP** tab. The key is verified against the provider
before it is saved, so a typo fails immediately rather than mysteriously later.

**3. Point your MCP client at Voice Box.**

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add voice-box -- npx -y @anomalypoint/voice-box@latest mcp
```

Add `-s user` to make it available in every project.
</details>

<details>
<summary><b>Claude Desktop / Cursor / other MCP clients</b></summary>

Add to `claude_desktop_config.json`, `.cursor/mcp.json`, or your client's equivalent:

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "@anomalypoint/voice-box@latest", "mcp"]
    }
  }
}
```
</details>

> There is deliberately **no `env` block**. Keys live in the control panel, so you
> configure them once instead of pasting them into every project.

**4. Ask your agent to speak.** It registers itself automatically, picks up an unused
voice, and tells you where to change it.

---

## The control panel

`npx @anomalypoint/voice-box` opens it at `http://127.0.0.1:4517`.

| Tab | What it does |
| --- | --- |
| **CHANNELS** | Every agent as a channel strip: rename, assign a voice, preview it, set volume, mute, or forget the agent |
| **CUE** | What is playing and what is queued, with per-item skip |
| **LOG** | Everything that has been spoken, with replay |
| **SETUP** | Provider keys (verified before saving), audio backend, master volume |
| **DIAG** | Detected players, versions, live sessions |

The transport bar at the top pauses, skips, and clears the queue globally.

**Pause** takes effect at the utterance boundary — the current line finishes rather than
being cut off mid-sentence.

---

## How agents get their identity

This is the part that keeps a long-running setup tidy.

- A **profile** is persistent: name, voice, project, mute state. It survives restarts.
- A **session** is one live MCP process, bound to a profile.

When an agent connects, the MCP process already knows its working directory and process
id, so it **claims a profile automatically** — no cooperation from the model required:

1. If a profile for that project is free, it is reused, keeping the name and voice you
   assigned. Restarting an agent creates nothing new.
2. If another agent is already using it, a new one is minted (`my-project #2`) with the
   next unused voice, so the two are audibly distinguishable.
3. If an agent crashes or is force-quit, its slot is released automatically — Voice Box
   checks whether the process is still alive rather than relying on a polite goodbye.

**Speaking never requires registering first.** The `voice_register` tool only *renames*
the profile an agent already has, and it is keyed on project + name, so calling it
repeatedly can never fan out into duplicates.

**You own voice assignment.** Once you pick a voice in the panel, agents cannot override
it.

---

## Tools exposed to agents

| Tool | Purpose |
| --- | --- |
| `speak` | Say something out loud. Returns as soon as it is queued, not when playback finishes. |
| `voice_register` | Give this agent a display name, e.g. its persona. |
| `voice_status` | Check the queue, and whether this agent is muted. |

`speak` accepts an optional `priority` (`low`/`normal`/`high`/`urgent`) and `wait`
(`none`/`accepted`/`played`).

### Getting the most out of it

Add something like this to your `CLAUDE.md` so voice is used well rather than constantly:

```markdown
Use the voice-box `speak` tool at key moments — starting a task, finishing one,
hitting a problem, or asking a question. Keep it to a sentence or two of natural
speech. Put detail (code, paths, errors, lists) in your text reply instead, since
speech cannot be skimmed. Do not narrate every step.
```

---

## Queue behaviour

One utterance plays at a time, because there is one pair of speakers.

- **Fair ordering.** Priority band first, then round-robin across agents. One chatty
  agent cannot monopolise the speaker.
- **Stale messages expire.** Default TTL is 120s. "Working on this now" heard four
  minutes later is worse than silence.
- **Muting is free.** Enforced before synthesis, so a muted agent costs nothing in API
  credits.
- **Backpressure is per-agent.** An agent that queues faster than the speaker is held
  briefly; other agents are never blocked by it.
- **Crashed agents are cleaned up.** Their pending routine messages are dropped.

All of it is tunable in `~/.voice-box/config.json`.

---

## CLI

```
voice-box                    Start the daemon and open the control panel
voice-box mcp                Run the MCP stdio server (what MCP clients invoke)
voice-box status             Show agents and the queue as text
voice-box speak <text>       Queue something to say, for testing
voice-box keys set <p>       Store an API key (read from stdin, not argv)
voice-box doctor --selftest  Diagnose the install and play a test tone
voice-box start|stop|restart Manage the daemon
voice-box logs [-n N]        Show the daemon log
```

---

## Configuration

Everything lives in `~/.voice-box/` (mode `0700`):

| File | Contents |
| --- | --- |
| `config.json` | Settings and agent profiles. Contains no secrets — safe to share in a bug report. |
| `secrets.json` | API keys, mode `0600`. |
| `daemon.json` | Runtime pid, port, and auth token. Removed on clean shutdown. |
| `history.jsonl` | What was spoken. |
| `cache/` | Synthesized audio, content-addressed and pruned automatically. |

Environment variables always take precedence over stored keys:

```bash
OPENAI_API_KEY=...  ELEVENLABS_API_KEY=...
```

Set `VOICE_BOX_HOME` to relocate the directory, or `VOICE_BOX_AGENT_NAME` in an MCP
config to pin an agent's name.

> On Windows, file permissions are inherited from your user profile — `chmod` is a no-op
> there, so the `0600` protection described above does not apply.

---

## Privacy and security

- The HTTP server binds **`127.0.0.1` only**. There is no setting to change that.
- Requests are authenticated with a token regenerated on every daemon start, and
  rejected if the `Host` or `Origin` header does not match loopback — which blocks
  DNS-rebinding attacks from a malicious web page.
- The panel receives your API key **only as a masked hint** (`sk-…a1b2`). The raw key
  never leaves the daemon.
- Logs pass through a redaction filter, so a key cannot be written to disk by accident.
- The only network calls are to the TTS provider you configured.

---

## Troubleshooting

**No sound.** Run `voice-box doctor --selftest`. On Linux, install one of the players
listed under Requirements.

**"No text-to-speech provider is configured."** Add a key in the SETUP tab, or set
`OPENAI_API_KEY` before starting the daemon.

**The daemon will not start.** Run `voice-box daemon` in a terminal to see the error
directly, or `voice-box logs`.

**A stale agent is listed.** Use the ✕ button in CHANNELS to forget it.

**Port 4517 is taken.** Voice Box tries 4517–4527 automatically. Pin one with
`daemon.port` in `config.json`.

---

## Upgrading from 1.x

Voice Box 2.0 is a clean break.

| 1.x | 2.0 |
| --- | --- |
| `args: ["-y", "@anomalypoint/voice-box@latest"]` | add `"mcp"` as a final argument |
| `env: { OPENAI_API_KEY }` in the MCP config | remove it; set the key in the panel |
| `text_to_speech` tool | `speak` |
| `voice` and `model` tool arguments | removed — voice is assigned in the panel |
| ffmpeg required | no longer used |

---

## Development

```bash
npm install
npm run build
npm test
npm run dev          # runs the CLI from source
```

No bundler and no CDN: the control panel is plain HTML, CSS, and ES modules, served
straight from the package, and works offline.

---

## License

MIT — see [LICENSE](LICENSE).
