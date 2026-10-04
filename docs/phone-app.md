# Android app

**Status: built, compiling, not yet run on a device.** Code is in [`frontend/`](../frontend/). Build and run steps: [frontend/README.md](../frontend/README.md). Rules for whoever works on it: [frontend/frontend.md](../frontend/frontend.md). The wire formats are [protocol.md](protocol.md) (WebSocket) and [risk-engine.md](risk-engine.md) (REST).

Stack: native Kotlin, Jetpack Compose, CameraX, Presage SmartSpectra SDK, OkHttp, installed over USB.

## What the app does

| # | Responsibility | Status |
|---|---|---|
| 1 | Full-screen dashcam view, no touch needed while driving | Done |
| 2 | Presage: eye closure, blinks, expression, HR, breathing, confidence | Compiles, untested on a face. Fake source for the demo. |
| 3 | 60 s baseline at trip start; low-confidence frames dropped | Done (phone model). The engine builds its own baseline from its first 6 windows. |
| 4 | 10 s window of raw signals sent to the risk engine (`POST /trips/{id}/windows`) | Done |
| 5 | Show the engine's score, tier, dominant factor, override, actions, degraded flag | Done |
| 6 | Trip lifecycle on the engine: start, end, report, per-driver history | Done |
| 7 | Feedback buttons: `false_alarm` / `confirmed` after an alert | Done |
| 8 | Fallback: phone `RiskModel` and `AlertGate` when the engine is off or unreachable | Done |
| 9 | WebSocket client: `hello`, `risk_window`, `settings`, `trip_start` / `trip_end`, `alert` (fallback only) | Done |
| 10 | GPS speed; IMU hard-brake and swerve detection | Done, untested on a device |
| 11 | Bundled alarm on `voice_urgent` (or tier 85 in fallback) | Done, placeholder tone |
| 12 | `navigate` opens maps; `dismissed` stops the alarm and nudges the local weights | Done |
| 13 | Settings: sharing mode, kids in car, new driver, hours slept, engine on/off, host, demo mode | Done |
| 14 | Report card (local) plus the engine's grade, time per tier and events | Done |
| 15 | History screen | Done |
| 16 | Play `speak.audio`, listen for replies (voice) | **Excluded.** `speak` is ignored; no mic. |
| 17 | Pre-trip questionnaire | **Excluded.** Replaced by three plain settings. |

## Who scores

The backend's logistic [risk engine](risk-engine.md) scores the trip: smoothing, levels, `R`, tiers, holds, overrides, cooldowns, the kids raise. The app sends raw signals only.

If `POST /trips` fails (backend without `DATABASE_URL`, unreachable) or the setting is off, the phone scores locally as before and sends `alert` frames. While the engine scores, the phone sends **no** `alert` frame: the backend already speaks for the engine's alert, so the phone's would double it.

## Signals sent per window

`ts`, `face_visible`, `heart_rate`, `breathing_rate`, `engagement`, `eye_closure_frac`, `longest_eye_closure_s`, `yawns`, `emotion_stress`, `gaze_off_road_s`, `hard_brakes`, `swerves`, `speed_mph`, `speed_limit_mph`. A signal that was not measured is omitted (null), not 0. `phone_in_hand` is never sent: there is no detector. `ts` is ISO 8601 and unique per trip.

## Events the backend uses (WebSocket `risk_window.events`)

- `yawn`, `nod`: roast text ("yawned 3 times in 4 minutes") and yawn counts in answers
- `hard_brake`: pauses driver speech for 10 s
- `swerve`: stored only

## What the backend handles

The app does not implement any of these:

- Which voice line to say and how (ElevenLabs), and playing it back to the driver
- Kids-in-car tier raise for engine trips; mapping engine actions to voice and iMessage
- Group chat, guardian alerts, roast, permission prompt when sharing is off
- Parsing "I'm fine", yes/no, and "tell her …"
- Per-driver weight changes from feedback, trip storage, report and grading

## Open gaps

- No `distracted` sub-score or gaze event in the WebSocket protocol. The engine's `distracted` level needs `gaze_off_road_s`, which the Presage SDK does not give.
- `phone_in_hand` has no source. The speed limit is a fixed 65 mph.
- Failed `end` and `report` calls are not retried.
- Not run on a device or against a live backend; only compiled and unit tested.
