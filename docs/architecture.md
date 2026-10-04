# Architecture

## Components

```
┌──────────────── Android app (NOT STARTED) ────────────────┐
│ Front camera → Presage → raw signal window                │
│ GPS / IMU → speed, hard brake, swerve                     │
│ Audio playback · speech recognition · maps intent         │
└──────────────┬──────────────────────────────▲─────────────┘
               │ risk_window, alert,          │ speak (mp3), navigate,
               │ utterance, speak_done, ...   │ dismissed, error
               ▼                              │
┌──────────────── Backend (Node / TypeScript, DONE) ────────┐
│ ws/server.ts ── orchestrator.ts ── voice/driverQueue.ts ──┼──► ElevenLabs TTS
│                    │      │                               │
│        risk/* (engine, not wired yet)                     │
│        trip/state.ts      agent/* ────────────────────────┼──► OpenRouter LLM
│        trip/store.ts (in-memory STUB → Tiger Data)        │
│                           │                               │
│                    agent/spectrum.ts ─────────────────────┼──► Photon Spectrum
└───────────────────────────────────────────────────────────┘        │
                                                          iMessage group / DMs
                                                          (Telegram optional)
```

- **Android app.** Not in the repo. It is meant to own sensing and send raw signal windows; scoring and the decision tree move to the backend risk engine. Spec: [phone-app.md](phone-app.md).
- **Backend.** One Node process. It holds trip state, talks to the phone over a WebSocket, talks to the family chat through Spectrum, and makes every third-party API call. API keys never reach the phone.

## Backend boot sequence

[`src/index.ts`](../backend/src/index.ts):

1. Create the `TripStore`. Today this is always `InMemoryTripStore`.
2. `createOrchestrator(store)` returns two handlers: `onPhone` for WebSocket frames and `onChat` for Spectrum messages.
3. `startPhoneServer(PORT, onPhone, status)` serves `ws://…/phone` and `GET /health`.
4. Unless `NO_SPECTRUM` is set, `startSpectrum(onChat)` connects to Photon and starts the inbound message loop.

## Who owns the decision tree

The root README's decision tree (§4) is moving from the phone to the backend. The [risk engine](risk-engine.md) implements the calculation and timing half; until it is wired in, the phone still has to send `R`, `tier` and `alert`.

| Responsibility | Owner | Status |
|---|---|---|
| Sense signals and send a window every 10 s | Phone | Not started |
| Compute levels, `R` and the dominant sub-score (logistic score) | Backend `risk/` | Module done, not wired |
| Map R to a tier (40 / 70 / 85) | Backend `risk/` | Module done, not wired |
| 2-window hold, 2 min per-tier cooldown, sustained and microsleep overrides | Backend `risk/` | Module done, not wired |
| Kids-in-car bump | Backend | Done in the orchestrator (70 → 85); the engine does its own +1 tier. Keep only one once wired. |
| Tier → spoken line (template + ElevenLabs settings) | Backend | Done |
| 85 → guardian alert, roast, or permission prompt depending on sharing mode | Backend | Done |
| "I'm fine" → `dismissed` frame | Backend | Done |
| Weight nudge on `dismissed` | Backend `risk/` | Module done (per-driver multipliers), not wired |

The phone **reports** and the backend **decides and acts**. Today the orchestrator still trusts `R` and `tier` from the phone; once the risk engine is wired in, it computes them from raw signal windows.

## Main data flows

### Risk window (every 10 s)

```
phone ── risk_window ──► orchestrator
                          ├─ starts a trip if none is active
                          ├─ trip.addWindow()       (keeps the last 30 min in memory)
                          ├─ hard_brake event? → driverQueue.pause(10 s)
                          └─ store.saveWindow()     (in-memory stub)
```

### Alert

```
phone ── alert{tier, dominant, R} ──► onAlert
   tier = 85 if (tier == 70 and kidsInCar) else tier
   tier < 85  → speak alert line (priority, listen 5 s, context "checkin")
   tier = 85  → speak urgent line (priority)
                sharing never → speak permission question (listen 5 s, context "permission")
                otherwise     → escalate():
                                  post guardian alert (+ maps link) to guardians
                                  dominant drowsy and no roast running → start roast, post roast call
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
   dismiss → send dismissed, ack, resolve roast if running
   yes     → after a check-in: navigate to a rest stop; during a roast: resolve it
   reply   → during a roast: resolve it; otherwise post "Alex says: …"
```

Details in [voice.md](voice.md#driver-intent-parsing).

## State

All runtime state is in process memory:

| State | Where | Lifetime |
|---|---|---|
| Current trip, last 30 min of windows, alert counts | `trip/state.ts` (`trip` singleton) | Until `trip_end` or restart |
| Sharing mode, kids in car, driver name | `trip` singleton | Until restart |
| Roast round | `agent/roast.ts` | 3 min, or until resolved |
| Pending permission question | closure in `orchestrator.ts` | Until a yes/no utterance |
| Speech queue | `voice/driverQueue.ts` | Cleared on `trip_end` |
| Group chat space, DM spaces | `agent/spectrum.ts` | Until restart |
| Trip history, windows, contact prefs | `InMemoryTripStore` | Until restart (**Stub** for Tiger Data) |

Only one phone can be connected at a time, and there is a single global trip. The backend serves one driver.
