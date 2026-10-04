# Implementation status

Every feature from the [root README](../README.md), checked against the code on 2026-10-03.

**Legend:** **Done**: implemented and wired end to end · **Built**: implemented and unit-tested, not yet verified on a device · **Partial**: some of it exists · **Stub**: an interface or placeholder exists, no real implementation · **Not started**: no code in the repo.

The phone app is [`frontend/`](../frontend) (Driver Guardian). It **senses and displays**: every 10 s it sends raw signals, and the backend's **risk engine** scores them, decides every alert, stores the trip and drives voice and contacts (see [architecture.md](architecture.md#who-owns-the-decision-tree)). The app builds and its `core` logic is unit-tested; the backend path is tested end to end with `fake-phone`; the full loop is not yet verified on a device. [`android/`](../android) (CoolVitals) is a standalone Presage demo kept as an SDK reference.

## 1. Driver sensing (Presage)

| Feature | Status | Notes |
|---|---|---|
| Presage SDK on device | Built | `frontend` `SmartSpectraPresageSource`: pulse, breathing, blinks, expression, and face landmarks at 1 Hz. Face visibility comes from the SDK's validation status; pulse confidence only gates heart rate. |
| Eye closure from landmarks | Built | `core/FaceGeometry.kt`: eye aspect ratio → closure 0..1 (assumes the MediaPipe 478-point layout). |
| Yawn detection | Built | Presage has no yawn output (its face metrics are landmarks, blinking, talking, expressions). `FaceSampler` runs every landmark frame (MediaPipe Face Mesh, confirmed in the SDK) through `YawnDetector`: mouth openness ≥ 0.6 held 1.5 s, ≤ 150 ms jitter tolerated, one per 5 s. Emits the `yawn` event. Threshold to be tuned on device (Debug screen / `adb logcat -s Presage`). |
| Nod detection | Not started | `nod` event never set. |
| Longest continuous eye closure | Built | `FaceSampler` tracks closure runs across seconds; sent as `longest_eye_closure_s`, which drives the engine's microsleep override (≥ 1.5 s → tier 3). |
| 60 s per-trip baseline | Done (backend) | Engine: first 6 windows set baseline heart and breathing rate; tier 0 meanwhile. |
| Smoothing | Done (backend) | Engine: rolling mean over 3 windows before scoring. |
| Drop low-confidence frames | Built | Phone `WindowAggregator` ignores frames without a valid face; the engine goes `degraded` (speed and motion only) after 3 faceless windows. |
| Drowsy / reckless / distracted state derivation | Done (backend) | Engine levels: drowsy, agitated, speeding, phone, distracted, erratic. The phone doesn't send gaze or phone-in-hand yet, so distracted and phone stay 0. |

## 2. Pre-trip check (stretch)

| Feature | Status | Notes |
|---|---|---|
| Rested 1–5, hours slept, medication, experience | Not started | Excluded from the frontend brief; no protocol fields. |
| Kids in the car toggle | Built | Frontend settings → `hello` / `settings`; raises the multiplier `m` on the phone and the 70 → 85 bump on the backend. |

## 3. Risk score

| Feature | Status | Notes |
|---|---|---|
| Score | Done (backend) | Engine: z = Σ ln(odds ratio) × level (cited SHRP 2 / AAA values in `weights.json`), capped at ln 50, scaled 0–100. The phone scorer was removed. |
| Context multiplier | Done (backend) | Kids in car / low experience +15 % each. |
| Server-side logistic risk engine (REST + Postgres) | Done (backend) | Odds-ratio weights, baseline, overrides, cooldowns, feedback, report. See [risk-engine.md](risk-engine.md). The phone must call it; the legacy phone-computed path still works. |
| Trip report card, expression observations, adaptive notify threshold | Done (backend) | Stored per window and per trip; the care index lowers or raises the score needed to text contacts. Persisted on Tiger Data with retention and compression ([persistence.md](persistence.md)). Decisions and feedback rewards are logged in `decision_log` (separate from the bandit's `bandit_events`); no learner trains on it yet. See [risk-engine.md](risk-engine.md). |
| Adaptive recommendations (LinUCB bandit, Tiger Data) | Done (backend) | Picks the intervention within tier 1/2; `intervention` on the windows response, `GET /drivers/{id}/policy`. Off without `TIGER_DATABASE_URL`. The in-process voice path speaks the chosen intervention; REST clients choose their own script from `intervention.id`. `family_voice_warning` needs `ELEVENLABS_FAMILY_VOICE_ID`. See [risk-engine.md](risk-engine.md#adaptive-recommendations-contextual-bandit). |
| Weights | Done (backend) | `backend/src/risk/weights.json`. Drowsy OR 3.4 is flagged "check paper"; erratic is a placeholder. |
| "I'm fine" learning | Done (backend) | Recorded as false-alarm feedback: the dominant factor's weight ×0.95 for this driver (clamped 0.5–1.5, stored), bandit penalty. The phone shows the new multiplier. |
| Ridge regression fitting | Not started | Roadmap in the README too. |

## 4. Decision tree

The tree is split between phone and backend. See [architecture.md](architecture.md#who-owns-the-decision-tree).

| Rule | Status | Where |
|---|---|---|
| Tiers 1 / 2 / 3 at score 40 / 70 / 85, drowsy vs reckless dominance | Done (backend) | Engine `decision.ts`. |
| Hold before firing | Done (backend) | A score tier must hold 2 windows. |
| Cooldowns | Done (backend) | Voice 2 min per tier, contacts 10 min (by window timestamps). |
| Overrides | Done (backend) | Microsleep → tier 3; drowsy ≥ 0.6 for 3 windows → tier 2, 12 windows → tier 3; tier 2 for 12 windows → tier 3. |
| R < 40: log only | Done | Every `risk_window` is stored; no action. |
| 40 / 70: voice only, never the group chat | Done | `orchestrator.ts` `onAlert`. |
| Kids in car raises the tier | Done (backend) | Engine raises any active tier by one (set at trip start). |
| 85, sharing on: voice + group alert + roast (drowsy only) | Done | `escalate()`: alert to the group, location to guardians only. Reckless 85 alerts but does not start a roast. |
| 85, sharing off: ask driver by voice for permission | Done | `permissionLine()` then a 5 s listen. |
| "I'm fine" dismiss | Built | Phone mic → backend → engine feedback. |
| Loud bundled alarm audio file at the alarm stage | Built | Phone `AlarmPlayer` on an evaluation with `voice_urgent`; `alarm.wav` is a placeholder tone. |

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
| Full-screen hands-free dashcam UI | Built | Portrait, styled after the Figma "UI" design (light theme, icon tab bar): status pill (speaking / listening / yawn / can't see driver), speed vs limit, a 3D Mapbox map card (ported from CoolVitals, `DriveMap.kt`) with the driver camera as a small picture-in-picture, attention · drowsiness · eye tracking · speech tiles, drive/stats/contacts/settings tabs; only Drive while moving. Needs a Mapbox public token in `frontend/app/src/main/res/values/mapbox_access_token.xml` (gitignored, see `mapbox_access_token.xml.example`), otherwise the card shows a note. Not yet checked on a device. |

## 6. Photon iMessage agent

| Feature | Status | Notes |
|---|---|---|
| Connected through Photon Spectrum | Done | `agent/spectrum.ts`. iMessage, with Telegram as an optional extra provider (setup: [imessage-agent.md](imessage-agent.md#telegram-setup)). |
| Allowlist with guardian / friend roles | Done (backend) | `contacts.json`, with an optional `platform` per contact; live, and every change is written back. Without the file, dev mode treats every sender as a guardian until the first contact is added. The phone can list, remove and add contacts (`contacts_list`, `contact_remove`, `contact_add`): Telegram contacts join through a single-use 15 min invite link (`/start <code>` in a DM to the bot, needs `TELEGRAM_BOT_USERNAME`); adding iMessage contacts from the app is not available yet. `contact_update` flips guardian / friend. Tested with `fake-phone -- --contacts` and unit tests. Invite redemption not yet tried against a real bot. See [imessage-agent.md](imessage-agent.md#adding-contacts-from-the-phone-app). |
| Contacts tab | Built | `ContactsScreen.kt`, after the Figma "Android Compact - 4" frame: search (text or voice), + opens a Telegram invite dialog with a share button, rows with initials avatars and a guardian switch, tap a row to remove, "Create group" opens Telegram's add-bot-to-group picker (`groupLink`) and shows "Family group connected" once bound. Checked on a Galaxy S24 against the live backend (list and group status); add, toggle and remove not yet tapped through on the device. |
| Family group chat binding survives restarts | Done (backend), untested live | Saved to `.group.json` on `/start` or auto-capture, restored at startup with `space.get(id)`; `GROUP_CHAT_ID` overrides it. Not yet tried against a real Telegram group. |
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
| Every 10 s window persisted | Done (backend) | Each phone window is stored by the risk engine (`windows`, `events` hypertables on Tiger Data via `DATABASE_URL`; in-memory fake DB when unset). |
| Report card: line chart, letter grade, advice | Built | Phone `ReportCardScreen`, built from the engine's evaluations. The engine also serves `GET /trips/{id}/report`. |
| Weekly trends | Not started | |

## 8. Surroundings (stretch)

| Feature | Status | Notes |
|---|---|---|
| GPS speed | Built | Frontend `MotionSource` (demo mode fakes 65 mph). |
| Speed vs. fixed demo limit | Built | `speed_over_limit` feature. |
| GPS speed and location | Done (backend), phone not started | `gps` field on the 10 s window feeds `speeding` and `erratic`; location goes into the tier 3 alert and guardian answers. See [gps.md](gps.md). The legacy `risk_window` `lat`/`lon` still works. |
| Speed vs. posted limit | Done (backend) | OpenStreetMap through Overpass, cached, never blocks scoring, hand-set fallback by road class (flagged in the report card). Not measured on a real drive yet. |
| Trip start/stop from GPS | Done (backend) | 4 m/s for 20 s starts, under 1 m/s for 5 min ends the trip. |
| Rest stop and limit in voice lines, route on the report card | Done (backend) | `voice/lines.ts`, `card.gps`. |
| GPS DDL on Tiger | Not applied | `gps_samples`, `gps_10s` and the retention policy are in `sql/01_schema.sql`, tested on plain Postgres only. Re-run both SQL files on the service. |
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
- **`/start`** command in a group chat binds the agent to that group, and the binding is saved across restarts. **`/start <code>`** in a DM redeems a contact invite from the app.
- **`GET /health`** status endpoint.

## Known issues and gaps

These come from reading the code. None of them break the type check (`npm run typecheck` passes).

1. **Driver name drift.** The phone's `hello.driverName` updates trip state, but the classifier prompt, the answer prompt and the `/start` greeting use `DRIVER_NAME` from `.env`. If the two differ, the agent uses both names.
2. **Telegram DMs need the contact to write first.** Telegram bots can't open a DM, so `dm()` only reaches a Telegram contact who has messaged the bot privately since the last restart (redeeming an invite counts); otherwise it logs a warning and skips them. Group posts work once the group is bound.
3. **Arrival pings ignore sharing mode.** With sharing set to `never`, the trip summary is suppressed, but contacts who asked to be told on arrival still get a DM.
4. **Settings are fixed per engine trip.** Kids in car and sharing mode are read when the engine trip starts; toggling them mid-trip only affects the chat side until the next trip.
5. **Permission prompt never expires.** If the driver never answers "Do you want me to let your family know?", the next yes/no utterance, even minutes later, is treated as the answer.
6. **Mostly in memory.** A restart loses trip history, contact preferences, pending contact invites and the DM space cache. The group chat binding (`.group.json`) and contacts added from the app (`contacts.json`) survive.
7. **`/start` is not allowlisted.** Any member of any group can bind the agent's group chat with `/start`.
8. **No auth on the WebSocket.** Anyone who can reach the port can connect as the phone, and a new connection replaces the current one. Since the contact frames, that also lets them list (Telegram ids and phone numbers), remove and invite contacts.
9. **Unused state.** `driverQueue.lastContext` is written but never read.
10. **Odd example filename.** The example allowlist is named `contacts.example copy.json` instead of `contacts.example.json`.
11. **Face ratios assume MediaPipe indices.** If Presage's 478 landmarks are ordered differently, eye closure and yawns will be noise; blinks still work.
