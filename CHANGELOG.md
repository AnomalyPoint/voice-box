# Changelog

All notable changes to `@anomalypoint/voice-box` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/).

## [3.1.0] - 2026-08-02

### Added
- **Per-agent pause.** Every agent strip has its own PAUSE: the agent finishes its
  current sentence, then its queue holds while other agents keep playing. Held
  messages never expire (the held time is credited back to their TTL on resume), and
  holds die with the agent (disconnect or FORGET). `POST /queue/commands`
  `pause`/`resume` accept an optional `profileId`; `QueueSnapshot` gains
  `pausedProfiles`.
- **mpv as a first-class backend.** When mpv is installed, Voice Box drives it over
  its JSON IPC socket (auto-preferred; capability-probed first, with a graceful
  fallback for mpv builds without IPC support). This enables true mid-word pause and
  resume, plus **live volume** — slider changes reach audio that is already playing.
  The IPC socket lives in `~/.voice-box/run/` (0700).
- **A playback watchdog.** A player process that hangs can no longer wedge the single
  playback lane; the item settles as failed and the queue recovers on its own.
- **Console control panel.** The panel is now a mixing-desk console: one channel strip
  per agent with a CRT screen showing a face generated from the agent's identity —
  28 archetypes, seeded per agent, tinted with the agent's color. Faces blink, follow
  the cursor, animate while speaking, and sleep when the agent is offline. Green/red
  presence LEDs replace the old dimmed-column offline treatment; strips carry a LEVEL
  fader with a % readout and a LIVE/NEXT badge, a per-strip PAUSE, and an animated LED
  meter while speaking.
- `voice-box` settings now name the actually-running backend ("Auto — currently …")
  and explain what installing mpv unlocks.

### Changed
- Per-agent volume is read at play time instead of frozen when a message is enqueued,
  so moving a slider affects everything that has not sounded yet. Master and per-agent
  changes also reach the currently-playing clip on mpv.
- Global pause on backends without a control channel (afplay, ffplay, mpg123, VLC,
  PowerShell) now finishes the current sentence and then holds — the transport shows
  PAUSING while it does. Pausing also freezes a sounding replay (on mpv) instead of
  letting it play under a PAUSED banner.
- SKIP now stops a sounding replay/preview instead of ignoring the user lane.
- Voice previews and replays honour the agent's volume consistently.
- New agents get phosphor-friendly identity colors suited to the CRT screens.
- `speak` from a paused (held) agent returns immediately with a warning instead of
  hanging on backpressure or a `wait: "played"` deadline.

### Fixed
- **Pause no longer stutters and breaks playback on macOS.** Pause was implemented by
  sending SIGSTOP to the player process; freezing afplay's CoreAudio threads made the
  stream underrun audibly and could wedge the process past recovery, silencing all
  agents until a restart. SIGSTOP is gone on every platform.
- A pause landing during synthesis no longer shows PREPARING forever.
- The progress clock only freezes when the audio is actually frozen, not during a
  boundary pause while the sentence is still sounding.

### Notes
- The HTTP/MCP protocol changes are additive; `PROTOCOL_VERSION` stays 1 and older
  MCP clients are unaffected.
- `npm publish` is now gated by `prepublishOnly` (typecheck + full test suite).

## [3.0.2] - 2026-07-31

- Recover `speak` after daemon restarts: clients re-register and retry once on the new
  `unknown_session` error code.

## [3.0.1] - 2026-07-31

- Panel sign-in: adopt a token arriving on `hashchange` into an already-open tab, and
  persist re-auth in `localStorage`.

## [3.0.0] - 2026-07-30

- Rebuild the control panel as "Mission Control": one column per agent, real
  pause/resume, replay from history, live updates over SSE, persistent panel auth
  token, per-agent volume.

## [2.0.0] - 2026-07-29

- Rewrite as a multi-agent voice daemon with a control panel: one shared daemon owns
  the speakers, thin per-client MCP processes proxy to it over loopback HTTP.
  Fair multi-agent queueing, per-agent voices/profiles, provider keys managed in the
  panel, no ffmpeg dependency.

## [1.0.2] - 2025-11-06

- Fix npm README display.

## [1.0.1] - 2025-11-06

- Add npm badges; package metadata fixes.

## [1.0.0] - 2025-11-03

- Initial release: a single-agent MCP text-to-speech server (`text_to_speech` tool,
  OpenAI TTS, ffmpeg playback).
