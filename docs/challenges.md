# Challenges we ran into

What was hard while building Driver Guardian, what we did about it, and what is still open. Everything here comes from the commit history and [status.md](status.md); open items link to the page that tracks them.

## 1. Presage doesn't output a yawn

**Problem.** The plan called for yawn detection, but Presage's face metrics are landmarks, blinking, talking and expressions. There is no yawn signal.

**What we did.** `FaceSampler` runs every landmark frame (MediaPipe Face Mesh, confirmed in the SDK) through `YawnDetector`. A yawn is mouth openness ≥ 0.6 held for 1.5 s, with up to 150 ms of jitter tolerated and at most one per 5 s. Detection runs at frame rate rather than the 1 Hz metrics rate, because a yawn is too short to catch at 1 Hz.

**Still open.** The thresholds still need tuning on a device. Nod detection was never built.

## 2. Eye-closure thresholds didn't match a real phone

**Problem.** With the phone held below the face, open eyes on a Galaxy S24 read an eye aspect ratio of 0.23–0.28. The textbook `EAR_OPEN` of 0.28 made normal open eyes look about 25% closed, so 46 of 99 recorded seconds came out as HEAVY or CLOSED.

**What we did.** Recorded a session and retuned from the data: `EAR_OPEN` 0.28 → 0.22 and `EAR_CLOSED` 0.18 → 0.10. Replaying the same recording gave NORMAL for 93 seconds, with the rest being real closures. The tuning log now prints the raw ratio (`ear`, `earMin`) so the next retune is quick.

**Lesson.** Camera angle on the dash matters more than the paper values. Tune on the device, in the mounting position.

## 3. Deciding where the brain lives

**Problem.** The first phone app scored risk and ran the decision tree itself. The backend had its own path as well, so there were two sources of truth for alerts.

**What we did.** Moved scoring to a server-side logistic risk engine. The phone now sends raw signals every 10 s and displays the engine's verdict; the engine owns baselines, smoothing, tiers, holds, cooldowns and overrides. That meant a protocol change (`risk_window` to 10 s windows) made in step across the Kotlin client, `protocol.ts`, `PROTOCOL.md` and `docs/protocol.md`. The phone scorer was removed.

**Cost.** The legacy phone-computed path still works for compatibility, and the app can't score at all when it can't reach the backend.

## 4. Turning research numbers into weights

**Problem.** A defensible risk score needs published odds ratios, and not every behaviour we detect has a clean one.

**What we did.** Used cited SHRP 2 / AAA values in `weights.json`, with z = Σ ln(odds ratio) × level, capped at ln 50 and scaled to 0–100.

**Still open.** The drowsy odds ratio of 3.4 is flagged "check paper", and the erratic weight is a placeholder. Ridge regression fitting is not started.

## 5. Not annoying the driver (or the family)

**Problem.** A raw score crossing a threshold would fire an alert every few seconds, and a group chat that gets spammed gets muted.

**What we did.**
- A tier must hold for 2 windows before it fires.
- Cooldowns: voice 2 min per tier, contacts 10 min.
- Mid-tier events (40 / 70) are voice only and never reach the group chat.
- The first 6 windows set a per-trip baseline and stay at tier 0.
- "I'm fine" counts as false-alarm feedback: the dominant factor's weight is ×0.95 for that driver (clamped 0.5–1.5), plus a bandit penalty.
- Faceless windows go `degraded` (speed and motion only) after 3 in a row, instead of scoring noise.
- The family message queue pauses 10 s on a hard brake.

**Still open.** Family messages are always queued in order, even at high drowsiness. The "I'm fine" weight nudge has only been tested against `fake-phone`.

## 6. The driver can't touch the screen

**Problem.** Every feature had to work by voice, including permission to alert family. That means text-to-speech latency, a 5 s listen window, and turning a free-form spoken reply into an intent.

**What we did.** ElevenLabs tiered delivery (four presets for tiers 0 / 40 / 70 / 85), a driver speech queue, long messages shortened by an LLM to one line (over 120 characters), URLs read as "a link", media described ("Mom sent a photo"), and driver intent parsed by an LLM with a keyword fallback. The phone falls back to on-device TTS when the audio is empty and always sends `speak_done`, so the queue can't stall.

**Still open.** The permission prompt never expires: a yes/no minutes later is still treated as the answer ([status.md](status.md#known-issues-and-gaps), issue 5).

## 7. iMessage reachability

**Problem.** The agent had to be testable before we had reliable iMessage access, and group-chat behaviour differs between platforms.

**What we did.** Added Telegram as a second Spectrum provider for testing. That exposed platform differences:
- Telegram bots can't open a DM, so `dm()` only reaches a contact who has messaged the bot since the last restart.
- Telegram sends `/start@BotName` from the command menu, so the bind command has to accept it.
- Unknown senders are logged with a ready-to-paste `contacts.json` entry, since Telegram user ids have to be allowlisted.
- With no group chat bound, `post()` fans out to every allowlisted contact by DM.
- The tier 3 alert goes to the whole group, but the location link goes to guardians only.

**Still open.** The report card image has not been tried against a real iMessage or Telegram chat.

## 8. Speed limits without a paid API

**Problem.** "Speeding" needs the posted limit, and Overpass endpoints are free but flaky.

**What we did.** Overpass lookups are cached, never block scoring, skip endpoints that failed, and fall back to a backup. If none respond, a hand-set limit by road class is used and flagged in the report card. A trip starts at 4 m/s for 20 s and ends under 1 m/s for 5 min.

**Still open.** Not measured on a real drive.

## 9. Persistence on Tiger Data

**Problem.** Continuous aggregates can't run inside a transaction, so applying the schema as one script fails. Our smoke test also left its trip behind.

**What we did.** `npm run db:schema` applies `01_schema.sql` statement by statement and `02_seed.sql` as one query. `smoke:tiger` now cleans up by `trip_id` / `driver_id` rather than the old `id` columns. When no database URL is set, an in-memory fake Postgres keeps development working.

**Still open.** The GPS DDL (`gps_samples`, `gps_10s`, retention policy) has only been tested on plain Postgres and still needs applying on the service. Until persistence is wired everywhere, some chat state (contact preferences, the bound group, trip counts for "third late-night drive") lives in memory and is lost on restart.

## 10. Learning without data

**Problem.** A recommender that picks the best intervention needs data we didn't have before the demo.

**What we did.** A LinUCB contextual bandit on Tiger Data chooses the intervention within tier 1/2, with model updates serialised per driver and baseline windows skipped when computing the "before" reward. It is off when `TIGER_DATABASE_URL` is unset. Decisions and feedback rewards are logged in `decision_log`, so a better learner can be trained later.

**Still open.** Nothing trains on `decision_log` yet.

## 11. Parallel work, shared contract

**Problem.** Frontend, backend and Android SDK reference work moved at the same time on branches (`cvsys`, `rnoss`, worktrees), with one shared WebSocket protocol between them. Many commits are merges of `main` into a feature branch.

**What we did.** Made the protocol file the contract and required matching changes in the Kotlin client and both protocol docs in the same change. The repo's `AGENTS.md` files and `docs/status.md` kept the three of us (and the coding agents) from claiming features that weren't built.

**Cost.** Status drifted from reality more than once, for example the docs snapshot still saying the app "doesn't talk to the backend yet" after it did.

## 12. Not verified on a device yet

Most of the phone side is marked **Built** rather than **Done**: compiled and unit-tested, not run end to end on a phone. The backend path is tested with `fake-phone`. That includes the full camera → score → voice → iMessage loop, the alarm sound (`alarm.wav` is a placeholder tone), the trip summary popup, trip history and the report image on the phone.

## Known security gaps we chose to defer

Chosen deliberately for the hackathon timeline. See [status.md](status.md#known-issues-and-gaps): the WebSocket has no auth (a new connection replaces the current phone), and `/start` isn't allowlisted, so any group member can bind the agent.
