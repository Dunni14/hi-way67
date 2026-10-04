# Implementation status

Every feature from the [root README](../README.md), checked against the code on 2026-10-03.

**Legend:** **Done**: implemented and wired end to end on the backend · **Partial**: some of it exists · **Stub**: an interface or placeholder exists, no real implementation · **Not started**: no code in the repo.

The Android app is not in the repository. Any feature that lives on the phone is **Not started**, even where the backend is ready to receive its output.

## 1. Driver sensing (Presage)

| Feature | Status | Notes |
|---|---|---|
| Presage SDK on device (eyes, head pose, expression, HR, HRV, breathing) | Not started | Phone-side. No Android code in repo. |
| 60 s per-trip baseline | Not started | Phone-side. |
| 10 s rolling-average smoothing | Not started | Phone-side. |
| Drop low-confidence frames | Not started | Phone-side. |
| Drowsy / reckless / distracted state derivation | Not started | Phone-side. The protocol has no `distracted` sub-score or event yet. Only `drowsy` and `reckless` exist. |

## 2. Pre-trip check (stretch)

| Feature | Status | Notes |
|---|---|---|
| Rested 1–5, hours slept, medication, experience | Not started | No fields for these in the protocol. |
| Kids in the car toggle | Done (backend) | Sent in `hello` / `settings`. Used for the 70 → 85 tier bump. |

## 3. Risk score

| Feature | Status | Notes |
|---|---|---|
| Feature vector **x**, two weight vectors, base risk `r = w · x` | Not started | Phone-side. The backend receives the final `R`, `drowsy`, `reckless` and stores the optional `features` map without reading it. |
| Context/speed multiplier `m` | Not started | Phone-side. The backend applies kids-in-car only as a tier bump (see §4), not as a multiplier. |
| Hand-set weights | Not started | Phone-side. |
| "I'm fine" gradient step on **w** | Partial | Backend recognizes the phrase and sends `{"type":"dismissed"}`. Applying the nudge and showing weights on a debug screen is phone work and not started. |
| Ridge regression fitting | Not started | Roadmap in the README too. |

## 4. Decision tree

The tree is split between phone and backend. See [architecture.md](architecture.md#who-owns-the-decision-tree).

| Rule | Status | Where |
|---|---|---|
| Tier thresholds 40 / 70 / 85, drowsy vs reckless dominance | Not started | Phone decides and sends `alert`. |
| 15 s hold before firing | Not started | Phone. |
| 2 min cooldown per tier | Not started | Phone. The backend has **no** cooldown of its own; every `alert` it receives is acted on. |
| "70+ sustained for 2 minutes" escalates to 85 | Not started | Phone. |
| R < 40: log only | Done | Every `risk_window` is stored; no action. |
| 40 / 70: voice only, never the group chat | Done | `orchestrator.ts` `onAlert`. |
| Kids in car: 70 treated as 85 | Done | `orchestrator.ts` `onAlert`. |
| 85, sharing on: voice + guardian alert + roast (drowsy only) | Done | `escalate()`. Reckless 85 alerts guardians but does not start a roast. |
| 85, sharing off: ask driver by voice for permission | Done | `permissionLine()` then a 5 s listen. |
| "I'm fine" dismiss | Done (backend) | See §3 for the weight nudge. |
| Loud bundled alarm audio file at the alarm stage | Not started | No audio asset; 85 uses the urgent TTS voice settings instead. |

## 5. Voice (ElevenLabs)

| Feature | Status | Notes |
|---|---|---|
| ElevenLabs key only on backend | Done | `voice/elevenlabs.ts`. |
| Tiered delivery (same voice, different settings) | Done | Four settings presets for 0 / 40 / 70 / 85. |
| Check-in → "yes" opens navigation | Done (backend) | Sends `{"type":"navigate","query":"rest stop"}`. Opening maps is phone work, not started. |
| "I'm fine" logs dismissal and backs off | Partial | Backend acks by voice and sends `dismissed`. "Backs off" depends on the phone's cooldown, not started. |
| Reads family messages, one line | Done | Messages over 120 characters are shortened by LLM. URLs become "a link". |
| Photos, videos, files, links described | Done | "Mom sent a photo." etc. |
| Listen 5 s after a message, relay reply | Done (backend) | Backend sets `listenAfterMs: 5000` and handles the `utterance`. Speech recognition on the phone is not started. |
| Roasts go through immediately at high drowsiness | Done | Roasts are enqueued as priority. |
| Family messages go through immediately at high drowsiness | Not started | Normal family messages are always queued in order, regardless of risk. |
| Full-screen hands-free dashcam UI | Not started | Phone. |

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
| Report card: line chart, letter grade, advice | Not started | |
| Weekly trends | Not started | |

## 8. Surroundings (stretch)

| Feature | Status | Notes |
|---|---|---|
| GPS speed | Not started (phone) | Backend accepts `speed` and `lat`/`lon` and uses them in answers, roast text and maps links. |
| Speed vs. fixed demo limit | Not started | |
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
