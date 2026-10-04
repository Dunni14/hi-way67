# Implementation status

Every feature from the [root README](../README.md), checked against the code on 2026-10-03.

**Legend:** **Done**: implemented and wired end to end · **Built**: implemented and unit-tested, not yet verified on a device · **Partial**: some of it exists · **Stub**: an interface or placeholder exists, no real implementation · **Not started**: no code in the repo.

The phone app is [`frontend/`](../frontend) (Driver Guardian). It computes the score, runs the phone half of the decision tree, plays the backend's voice and listens for replies. It builds and its `core` logic is unit-tested, but it hasn't been verified end to end on a device yet. [`android/`](../android) (CoolVitals) is a standalone Presage demo with a face-metrics debug overlay, kept as an SDK reference. Details: [phone-app.md](phone-app.md).

## 1. Driver sensing (Presage)

| Feature | Status | Notes |
|---|---|---|
| Presage SDK on device | Built | `frontend` `SmartSpectraPresageSource`: pulse, breathing, blinks, expression, and face landmarks at 1 Hz. Face visibility comes from the SDK's validation status; pulse confidence only gates heart rate. |
| Eye closure from landmarks | Built | `core/FaceGeometry.kt`: eye aspect ratio → closure 0..1 (assumes the MediaPipe 478-point layout). |
| Yawn detection | Built | `YawnDetector`: mouth openness > 0.6 for 1.5 s, at most one per 5 s. Emits the `yawn` event. |
| Nod detection | Not started | `nod` event never set. |
| 60 s per-trip baseline | Built | `frontend/core` `TripEngine`; "Calibrating…" on screen, no alerts meanwhile. |
| 10 s rolling-average smoothing | Built | `SignalSmoother`. |
| Drop low-confidence frames | Built | Frames without a valid face are dropped and signals go missing ("Can't see driver"). |
| Drowsy / reckless / distracted state derivation | Partial | Drowsy and reckless sub-scores are sent. Distracted is computed for the debug view only: the protocol has no field for it. |

## 2. Pre-trip check (stretch)

| Feature | Status | Notes |
|---|---|---|
| Rested 1–5, hours slept, medication, experience | Not started | Excluded from the frontend brief; no protocol fields. |
| Kids in the car toggle | Built | Frontend settings → `hello` / `settings`; raises the multiplier `m` on the phone and the 70 → 85 bump on the backend. |

## 3. Risk score

| Feature | Status | Notes |
|---|---|---|
| Feature vector **x**, two weight vectors, base risk `r = w · x` | Built | `frontend/core` `RiskModel`, 13 features sent in `risk_window.features`. |
| Context/speed multiplier `m` | Built | Kids in car + speed. Medication and experience fixed at 0. |
| Server-side logistic risk engine (REST + Postgres) | Done (backend) | Odds-ratio weights, baseline, overrides, cooldowns, feedback, report. See [risk-engine.md](risk-engine.md). The phone must call it; the legacy phone-computed path still works. |
| Adaptive recommendations (LinUCB bandit, Tiger Data) | Done (backend) | Picks the intervention within tier 1/2; `intervention` on the windows response, `GET /drivers/{id}/policy`. Off without `TIGER_DATABASE_URL`. The in-process voice path speaks the chosen intervention; REST clients choose their own script from `intervention.id`. `family_voice_warning` needs `ELEVENLABS_FAMILY_VOICE_ID`. See [risk-engine.md](risk-engine.md#adaptive-recommendations-contextual-bandit). |
| Hand-set weights | Built | Phone path: `WeightStore.defaults`. The engine's weights live in `backend/src/risk/weights.json`. |
| "I'm fine" gradient step on **w** | Built | Backend parses the phrase and sends `dismissed`; the frontend nudges the dominant weights and shows before/after on the Debug screen. |
| Ridge regression fitting | Not started | Roadmap in the README too. |

## 4. Decision tree

The tree is split between phone and backend. See [architecture.md](architecture.md#who-owns-the-decision-tree).

| Rule | Status | Where |
|---|---|---|
| Tier thresholds 40 / 70 / 85, drowsy vs reckless dominance | Built | Frontend `AlertGate`, sends `alert`. |
| 15 s hold before firing | Built | `AlertGate`. |
| 2 min cooldown per tier | Built | `AlertGate`. The backend has **no** cooldown of its own on this path. |
| "70+ sustained for 2 minutes" escalates to 85 | Built | `AlertGate`. |
| R < 40: log only | Done | Every `risk_window` is stored; no action. |
| 40 / 70: voice only, never the group chat | Done | `orchestrator.ts` `onAlert`. |
| Kids in car: 70 treated as 85 | Done | `orchestrator.ts` `onAlert`. |
| 85, sharing on: voice + group alert + roast (drowsy only) | Done | `escalate()`: alert to the group, location to guardians only. Reckless 85 alerts but does not start a roast. |
| 85, sharing off: ask driver by voice for permission | Done | `permissionLine()` then a 5 s listen. |
| "I'm fine" dismiss | Built | Backend + frontend mic and weight nudge. |
| Loud bundled alarm audio file at the alarm stage | Built | `frontend` `AlarmPlayer`; `alarm.wav` is a placeholder tone. |

## 5. Voice (ElevenLabs)

| Feature | Status | Notes |
|---|---|---|
| ElevenLabs key only on backend | Done | `voice/elevenlabs.ts`. |
| Tiered delivery (same voice, different settings) | Done | Four settings presets for 0 / 40 / 70 / 85. |
| Phone plays the voice | Built | `frontend` `VoicePlayer`: plays `speak.audio` (mp3), falls back to on-device TTS when it's empty, always sends `speak_done`. |
| Check-in → "yes" opens navigation | Built | Backend sends `navigate`; the frontend opens maps. |
| "I'm fine" logs dismissal and backs off | Built | Backend acks by voice and sends `dismissed`; the frontend's per-tier cooldown keeps running. |
| Reads family messages, one line | Done | Messages over 120 characters are shortened by LLM. URLs become "a link". |
| Photos, videos, files, links described | Done | "Mom sent a photo." etc. |
| Listen 5 s after a message, relay reply | Built | Frontend runs `SpeechRecognizer` for `listenAfterMs` and sends `utterance` with the same `context`. Needs the mic permission. |
| Roasts go through immediately at high drowsiness | Done | Roasts are enqueued as priority. |
| Family messages go through immediately at high drowsiness | Not started | Normal family messages are always queued in order, regardless of risk. |
| Full-screen hands-free dashcam UI | Built | Portrait, keep-screen-on, immersive; controls only enabled while parked. |

## 6. Photon iMessage agent

| Feature | Status | Notes |
|---|---|---|
| Connected through Photon Spectrum | Done | `agent/spectrum.ts`. iMessage, with Telegram as an optional extra provider (setup: [imessage-agent.md](imessage-agent.md#telegram-setup)). |
| Allowlist with guardian / friend roles | Done | `contacts.json`, with an optional `platform` per contact. Without the file, dev mode treats every sender as a guardian. |
| Flow 1: contacts ask, agent answers | Done | LLM answer over pre-filtered facts; location only for guardians. |
| Flow 2: contacts → driver | Done | Queued and spoken. Replies "isn't driving right now" when no trip. |
| Flow 3: driver → contacts | Done | "Tell her I'm stopping in ten" → `🗣️ Alex says: "…"`. |
| Flow 4: the roast | Done | 3 min window; resolves when the driver talks back. |
| Message classification (question / to driver / roast / arrival pref / chatter) | Done | LLM via OpenRouter, keyword fallback if the LLM fails. |
| No group alarm for mid-tier events | Done | |
| No delivery during hard braking | Done | Queue pauses 10 s on a `hard_brake` event. |
| "Third late-night drive this week" | Partial | Logic done, but trip history is in memory, so it only counts trips since the last restart. |
| "Mom wants a message when he arrives" | Partial | Works, but stored in memory only. |
| Arrival message + trip summary | Done | Duration, warning count, peak risk. |
| Sharing modes: always / high only / never | Done | See [imessage-agent.md](imessage-agent.md#sharing-modes). |
| Fallback: DMs when there is no group chat | Done | `post()` fans out to every allowlisted contact by DM. |

## 7. Trip log and report card (Tiger Data)

| Feature | Status | Notes |
|---|---|---|
| Every 10 s window persisted | Stub | `InMemoryTripStore` holds windows in an array. No Tiger Data / Timescale client, no schema, no connection string. `index.ts` carries a `TODO(tiger-data)`. (The risk engine and bandit have their own Postgres / Tiger Data stores.) |
| Report card: line chart, letter grade, advice | Built | Frontend `ReportCardScreen` after "End trip", computed from the windows the phone held. |
| Weekly trends | Not started | |

## 8. Surroundings (stretch)

| Feature | Status | Notes |
|---|---|---|
| GPS speed | Built | Frontend `MotionSource` (demo mode fakes 65 mph). |
| Speed vs. fixed demo limit | Built | `speed_over_limit` feature. |
| Open-Meteo weather | Not started | |
| Night-time driving | Built | `night_time` feature on the phone; the backend also uses 22:00–05:00 for the late-night trip note. |
| `surroundings_risk` feature | Not started | |

## Other tracks

| Item | Status |
|---|---|
| Fetch.ai / Agentverse agent | Not started |
| Notability screenshots | Not applicable to code |

## Additions not in the root README

- **OpenRouter** handles the LLM calls (classify, answer, shorten). A model can be set per job in `.env`.
- **Telegram** provider, so you can test without iMessage access.
- **`fake-phone`** dev client that plays the Android app (scripted or interactive).
- **Demo mode** in the frontend: scripted driver signals at a fake 65 mph.
- **`/start`** command in a group chat binds the agent to that group.
- **`GET /health`** status endpoint.

## Known issues and gaps

These come from reading the code. None of them break the type check (`npm run typecheck` passes).

1. **Driver name drift.** The phone's `hello.driverName` updates trip state, but the classifier prompt, the answer prompt and the `/start` greeting use `DRIVER_NAME` from `.env`. If the two differ, the agent uses both names.
2. **Telegram DMs need the contact to write first.** Telegram bots can't open a DM, so `dm()` only reaches a Telegram contact who has messaged the bot privately since the last restart; otherwise it logs a warning and skips them. Group posts work once the group is bound.
3. **Arrival pings ignore sharing mode.** With sharing set to `never`, the trip summary is suppressed, but contacts who asked to be told on arrival still get a DM.
4. **No backend cooldown.** Repeated 85 `alert`s each post a fresh alert. Flicker prevention relies entirely on the phone.
5. **Permission prompt never expires.** If the driver never answers "Do you want me to let your family know?", the next yes/no utterance, even minutes later, is treated as the answer.
6. **Everything is in memory.** A restart loses trip history, contact preferences, the captured group chat and the DM space cache. Someone must post in the group (or send `/start`) again after a restart.
7. **`/start` is not allowlisted.** Any member of any group can bind the agent's group chat with `/start`.
8. **No auth on the WebSocket.** Anyone who can reach the port can connect as the phone, and a new connection replaces the current one.
9. **Unused state.** `driverQueue.lastContext` is written but never read.
10. **Odd example filename.** The example allowlist is named `contacts.example copy.json` instead of `contacts.example.json`.
11. **Face ratios assume MediaPipe indices.** If Presage's 478 landmarks are ordered differently, eye closure and yawns will be noise; blinks still work.
