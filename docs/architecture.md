# Architecture

## Components

```
┌──────────────── Android app (frontend/) ──────────────────┐
│ Front camera → Presage → FaceSampler (eyes, yawns)        │
│ GPS / IMU → speed, hard brake, swerve                     │
│ WindowAggregator → raw signals every 10 s                 │
│ Screen · alarm · audio playback · speech recognition      │
└──────────────┬──────────────────────────────▲─────────────┘
               │ risk_window (raw signals),   │ evaluation, speak (mp3),
               │ utterance, speak_done, ...   │ navigate, dismissed, error
               ▼                              │
┌──────────────── Backend (Node / TypeScript) ──────────────┐
│ ws/server.ts ── orchestrator.ts ── voice/driverQueue.ts ──┼──► ElevenLabs TTS
│                    │                                      │
│                    ├── risk/ (engine) ── store ───────────┼──► Postgres / Tiger Data
│                    │       └── bandit/ (interventions)    │    (fake in-process DB if unset)
│        trip/state.ts (live view for chat)                 │
│                    └── agent/* ───────────────────────────┼──► OpenRouter LLM
│                         agent/spectrum.ts ────────────────┼──► Photon Spectrum
└───────────────────────────────────────────────────────────┘        │
                                                          iMessage / Telegram
```

- **Android app** (`frontend/`). Senses and displays. Every 10 s it sends one window of raw signals; it never scores. It shows the engine's verdict, plays the alarm, plays the backend's voice and listens for replies. `android/` is a standalone Presage demo kept as an SDK reference.
- **Backend.** One Node process. Its **risk engine** (`src/risk`, see [risk-engine.md](risk-engine.md)) scores every window and decides every alert; the orchestrator carries those decisions out (voice, group chat, contacts). It makes every third-party API call; keys never reach the phone.

## Backend boot sequence

[`src/index.ts`](../backend/src/index.ts):

1. Create the in-memory `TripStore` (chat facts: recent trips, contact preferences) and the orchestrator.
2. Open the risk store: `DATABASE_URL` (Tiger Data), or the seeded in-process fake database when it is unset or unreachable (or `FAKE_DB=1`). The engine always runs.
3. Create the bandit (on `TIGER_DATABASE_URL`, or the fake database), then the `RiskService` with the orchestrator's `onRiskEvaluation` as its hook; hand it to the orchestrator (`setRisk`) and mount the REST routes.
4. `startPhoneServer(PORT, onPhone, status, riskRoutes)` serves `ws://…/phone`, `GET /health` and the risk REST API.
5. Unless `NO_SPECTRUM` is set, `startSpectrum(onChat)` connects to Photon.

## Who owns the decision tree

All of it is on the backend now; the phone only senses.

| Responsibility | Owner |
|---|---|
| Collect 10 s of raw signals (eye-closure share, longest closure, yawns, vitals, speed, IMU events) | Phone (`WindowAggregator`) |
| Baseline (2 windows = 20 s, `baselineWindows` in `weights.json`), smoothing, levels, odds-ratio score | Engine (`risk/decision.ts`, `score.ts`, `levels.ts`) |
| Tier 0–3, 2-window hold, overrides (microsleep, sustained drowsiness, ignored warning), kids-in-car raise | Engine |
| Cooldowns (voice 2 min per tier, contacts 10 min) | Engine |
| Which line to say at tier 1/2 | Bandit (`bandit/`) |
| Speaking, group alert, location to guardians, roast, permission question | Orchestrator (`onRiskEvaluation` → `onAlert`) |
| "I'm fine" → false-alarm feedback (per-driver weight ×0.95, bandit penalty) | Orchestrator → engine |
| Alarm sound on `voice_urgent` | Phone |

## Main data flows

### Risk window (every 10 s)

```
phone ── risk_window{signals} ──► orchestrator.onRiskWindow
   ├─ starts the trip (and the engine trip) if none is active
   ├─ hard_brake event? → driverQueue.pause(10 s)
   ├─ risk.ingestWindow() → stores the window (+ event) in Postgres/Tiger, returns the evaluation
   │     └─ hook → onRiskEvaluation → voice / contacts (below)
   ├─ trip.addWindow()   (live view for chat answers and the roast text)
   └─ sendToPhone(evaluation)
```

### Alert

```
engine evaluation{tier, dominant, actions, intervention?} ──► onRiskEvaluation → onAlert
   tier 1/2 (voice_nudge / voice_warning) → speak the bandit's line, or the template (priority, listen 5 s)
   tier 3   (voice_urgent)                → speak urgent line (priority)
            notify_contacts           → escalate(): alert to the group, location to guardians,
                                         drowsy and no roast running → start roast, post roast call
            ask_permission_to_notify  → speak permission question (listen 5 s, context "permission")
```

### Chat message

```
Spectrum inbound ──► spectrum.route()
   "/start" in a group  → bind group, send greeting
   sender not in allowlist → ignore
   capture group space / DM space
   non-text → "X sent a photo/video/file/link"; reactions etc. ignored
   ──► onChat → classify() → question | to_driver | roast_reply | arrival_pref | chatter
```

Details in [imessage-agent.md](imessage-agent.md).

### Driver speech

```
phone ── utterance{text, context} ──► parseDriverUtterance()  (regex)
   pending permission → yes: escalate / no: acknowledge
   dismiss → engine false-alarm feedback, send dismissed{factor, multiplier}, ack, resolve roast if running
   yes     → after a check-in: navigate to a rest stop; during a roast: resolve it
   reply   → during a roast: resolve it; otherwise post "Alex says: …"
```

Details in [voice.md](voice.md#driver-intent-parsing).

## State

Live state is in process memory; scored trips persist in the risk store:

| State | Where | Lifetime |
|---|---|---|
| Current trip, last 30 min of windows, alert counts | `trip/state.ts` (`trip` singleton) | Until `trip_end` or restart |
| Sharing mode, kids in car, driver name | `trip` singleton | Until restart |
| Roast round | `agent/roast.ts` | 3 min, or until resolved |
| Pending permission question | closure in `orchestrator.ts` | Until a yes/no utterance |
| Speech queue | `voice/driverQueue.ts` | Cleared on `trip_end` |
| Group chat space, DM spaces | `agent/spectrum.ts` | Until restart |
| Engine trips, every scored window, alert events, per-driver weights, bandit models | Risk store (`risk/store/pg.ts`, `bandit/store.ts`): Postgres / Tiger Data | Permanent on Tiger (raw windows 7 days); in memory on the fake DB |
| Engine runtime per active trip | `RiskService` (rebuilt by replaying stored windows after a restart) | Until `trip_end` |
| Trip summaries for chat (late-night count), contact prefs | `InMemoryTripStore` | Until restart |

Only one phone can be connected at a time, and there is a single global trip. The backend serves one driver.
