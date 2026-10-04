# Implementation status

Every feature from the [root README](../README.md), checked against the code on 2026-10-04.

**Legend:** **Done**: implemented and wired end to end on the backend · **Partial**: some of it exists · **Stub**: an interface or placeholder exists, no real implementation · **Not started**: no code in the repo.

The Android app is in [`frontend/`](../frontend/) (see [phone-app.md](phone-app.md)). It compiles and its JVM tests pass, but it has **not been run on a device or against a live backend**, so phone-side rows are **Partial** at best. Presage on a real face is untested.

## 1. Driver sensing (Presage)

| Feature | Status | Notes |
|---|---|---|
| Presage SDK on device (eyes, head pose, expression, HR, HRV, breathing) | Partial | `SmartSpectraPresageSource` compiles, untested on a face. Gives pulse, breathing, blinks, expression; yawn, nod and gaze are not provided. A scripted fake source drives the demo. |
| 60 s per-trip baseline | Done (phone) | `Baseline` in `core`. The engine also builds its own from its first 6 windows. |
| 10 s rolling-average smoothing | Done (phone) | `SignalSmoother`. The engine smooths again over 3 windows. |
| Drop low-confidence frames | Done (phone) | Signals stay missing (null), never 0. |
| Drowsy / reckless / distracted state derivation | Done (backend engine) | The app sends raw signals and the engine derives the levels (drowsy, agitated, speeding, phone, distracted, erratic). The WebSocket protocol still has no `distracted` field. `phone_in_hand` has no source. |

## 2. Pre-trip check (stretch)

| Feature | Status | Notes |
|---|---|---|
| Rested 1–5, hours slept, medication, experience | Partial | No questionnaire (excluded). Settings hold "new driver" and optional hours slept, sent in `POST /trips` as `low_experience` and `sleep_hours`. No rested or medication input. |
| Kids in the car toggle | Done | Settings toggle. Sent in `hello` / `settings` (legacy 70 → 85 bump) and in `POST /trips` (engine raise). |

## 3. Risk score

| Feature | Status | Notes |
|---|---|---|
| Feature vector **x**, two weight vectors, base risk `r = w · x` | Done (phone, fallback) | `RiskModel` in `core`. Used only when the engine is off or unreachable. The backend stores the legacy `features` map without reading it. |
| Context/speed multiplier `m` | Done (phone, fallback) | `RiskModel.multiplier`. The engine has its own context multiplier. |
| Server-side logistic risk engine (REST + Postgres) | Done (backend and app) | Odds-ratio weights, baseline, overrides, cooldowns, feedback, report. See [risk-engine.md](risk-engine.md). The app calls it for trips, windows, feedback, report and history; not yet exercised against a live backend. |
| Hand-set weights | Done (phone, fallback) | `WeightStore.defaults`. The engine's weights live in `backend/src/risk/weights.json`. |
| "I'm fine" gradient step on **w** | Done | Backend sends `dismissed`; the app nudges the phone model and the debug screen shows the weights. Engine trips also use the False alarm / Confirmed buttons (`POST /trips/{id}/feedback`, per-driver x0.5 to x1.5). |
| Ridge regression fitting | Not started | Roadmap in the README too. |

## 4. Decision tree

The tree is split between phone and backend. See [architecture.md](architecture.md#who-owns-the-decision-tree).

| Rule | Status | Where |
|---|---|---|
| Tier thresholds 40 / 70 / 85, drowsy vs reckless dominance | Done | Engine tiers 1 to 3 when the engine scores; phone `AlertGate` sends `alert` as the fallback. |
| 15 s hold before firing | Done | Engine: 2-window hold. Phone fallback: 15 s. |
| 2 min cooldown per tier | Done | Engine has cooldowns (voice only). Phone fallback has a 2 min cooldown per tier. The legacy `alert` path on the backend still has none, so the phone never sends `alert` while the engine scores. |
| "70+ sustained for 2 minutes" escalates to 85 | Done | Engine override `tier2_sustained_12`; phone gate in fallback. |
| R < 40: log only | Done | Every `risk_window` is stored; no action. |
| 40 / 70: voice only, never the group chat | Done | `orchestrator.ts` `onAlert`. |
| Kids in car: 70 treated as 85 | Done | `orchestrator.ts` `onAlert`. |
| 85, sharing on: voice + guardian alert + roast (drowsy only) | Done | `escalate()`. Reckless 85 alerts guardians but does not start a roast. |
| 85, sharing off: ask driver by voice for permission | Done | `permissionLine()` then a 5 s listen. |
| "I'm fine" dismiss | Done (backend) | See §3 for the weight nudge. |
| Loud bundled alarm audio file at the alarm stage | Partial | App plays a bundled placeholder tone on `voice_urgent` (or tier 85 in fallback). Needs a real alarm file. The backend still uses the urgent TTS voice settings. |

## 5. Voice (ElevenLabs)

| Feature | Status | Notes |
|---|---|---|
| ElevenLabs key only on backend | Done | `voice/elevenlabs.ts`. |
| Tiered delivery (same voice, different settings) | Done | Four settings presets for 0 / 40 / 70 / 85. |
| Check-in → "yes" opens navigation | Done (backend) | Sends `{"type":"navigate","query":"rest stop"}`. The app opens maps. |
| "I'm fine" logs dismissal and backs off | Partial | Backend acks by voice and sends `dismissed`. "Backs off" depends on the engine's or phone's cooldown. |
| Reads family messages, one line | Done | Messages over 120 characters are shortened by LLM. URLs become "a link". |
| Photos, videos, files, links described | Done | "Mom sent a photo." etc. |
| Listen 5 s after a message, relay reply | Done (backend) | Backend sets `listenAfterMs: 5000` and handles the `utterance`. Speech recognition on the phone is excluded from the app. |
| Roasts go through immediately at high drowsiness | Done | Roasts are enqueued as priority. |
| Family messages go through immediately at high drowsiness | Not started | Normal family messages are always queued in order, regardless of risk. |
| Full-screen hands-free dashcam UI | Done | Compose dashcam; controls disabled above 3 mph. Untested on a device. |

## 6. Photon iMessage agent

| Feature | Status | Notes |
|---|---|---|
| Connected through Photon Spectrum | Done | `agent/spectrum.ts`. iMessage, with Telegram as an optional extra provider. |
| Allowlist with guardian / friend roles | Done | `contacts.json`. Without the file, dev mode treats every sender as a guardian. |
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
| Every 10 s window persisted | Stub | `InMemoryTripStore` holds windows in an array. No Tiger Data / Timescale client, no schema, no connection string. `index.ts` carries a `TODO(tiger-data)`. |
| Report card: line chart, letter grade, advice | Done (app) | Local card (chart, grade, advice) plus the engine's grade A to D, time per tier and events from `GET /trips/{id}/report`. Needs Postgres on the backend for the engine part. |
| Weekly trends | Partial | History screen lists past trips with grades (`GET /drivers/{id}/trips`). No weekly aggregation. |

## 8. Surroundings (stretch)

| Feature | Status | Notes |
|---|---|---|
| GPS speed | Done (app, untested on device) | Backend accepts `speed` and `lat`/`lon` and uses them in answers, roast text and maps links. |
| Speed vs. fixed demo limit | Done | Fixed 65 mph constant, sent as `speed_limit_mph`. |
| Open-Meteo weather | Not started | |
| Night-time driving | Partial | Backend uses 22:00–05:00 for the late-night trip note only. Not a risk feature. |
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
- **`/start`** command in a group chat binds the agent to that group.
- **`GET /health`** status endpoint.

## Known issues and gaps

These come from reading the code. None of them break the type check (`npm run typecheck` passes).

1. **Driver name drift.** The phone's `hello.driverName` updates trip state, but the classifier prompt, the answer prompt and the `/start` greeting use `DRIVER_NAME` from `.env`. If the two differ, the agent uses both names.
2. **DMs are iMessage only.** `dm()` always uses the iMessage provider. With `SPECTRUM_PROVIDERS=telegram` alone, guardian-only alerts, arrival pings and the no-group fallback fail. The error is logged, not thrown.
3. **Arrival pings ignore sharing mode.** With sharing set to `never`, the trip summary is suppressed, but contacts who asked to be told on arrival still get a DM.
4. **No backend cooldown.** Repeated 85 `alert`s each post a fresh guardian alert. Flicker prevention relies entirely on the phone.
5. **Permission prompt never expires.** If the driver never answers "Do you want me to let your family know?", the next yes/no utterance, even minutes later, is treated as the answer.
6. **Everything is in memory.** A restart loses trip history, contact preferences, the captured group chat and the DM space cache. Someone must post in the group (or send `/start`) again after a restart.
7. **`/start` is not allowlisted.** Any member of any group can bind the agent's group chat with `/start`.
8. **No auth on the WebSocket.** Anyone who can reach the port can connect as the phone, and a new connection replaces the current one.
9. **Unused state.** `driverQueue.lastContext` is written but never read.
10. **Odd example filename.** The example allowlist is named `contacts.example copy.json` instead of `contacts.example.json`.
