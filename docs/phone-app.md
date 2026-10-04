# Android app

**Status: Not started.** No Android code is in this repository. This page specifies what the app must do so it fits the backend that already exists. The design comes from the [root README](../README.md); the wire format is in [protocol.md](protocol.md).

Planned stack: native Kotlin, Presage native SDK, Android `SpeechRecognizer`, installed over USB.

## Responsibilities

| # | Responsibility | Status |
|---|---|---|
| 1 | Full-screen dashcam view, front camera facing the driver, no touch needed while driving | Not started |
| 2 | Presage: blinks, eye closure, head pose and nods, expression, HR, HRV, breathing, confidence | Not started |
| 3 | Send raw per-window signals (null when unknown); the backend [risk engine](risk-engine.md) handles baseline, smoothing, scoring and the decision tree | Not started |
| 4 | Mark low-confidence or missing signals as null; set `face_visible: false` when the face is lost | Not started |
| 5 | Signal window every 10 s: HR, breathing, engagement, eye closure, longest closure, yawns, stress, gaze off road, phone in hand, hard brakes, swerves, speed and limit | Not started |
| 6 | Trip start context: kids in car, low experience, hours slept | Not started |
| 7 | ~~On-device scoring and decision tree~~ Moved to the backend; the phone no longer computes `R` or tiers once the engine is wired in | Superseded |
| 8 | GPS speed and location; IMU hard-brake and swerve detection | Not started |
| 9 | WebSocket client: `hello` on connect, a signal window every 10 s (today `risk_window`, with `alert`), `settings`, `trip_start` / `trip_end` | Not started |
| 10 | Play `speak.audio` (base64 mp3), or on-device TTS when it is empty | Not started |
| 11 | Listen for `listenAfterMs` after a `speak`, send `utterance` with the same `context`, then `speak_done` | Not started |
| 12 | `navigate` → open maps searching "rest stop" | Not started |
| 13 | `dismissed` → optional debug display of the per-driver weight multipliers (the adjustment itself is backend-side) | Not started |
| 14 | Settings: sharing mode, kids in car | Not started |
| 15 | Pre-trip check screen (stretch) | Not started |
| 16 | Bundled alarm audio for the alarm stage | Not started |
| 17 | Report card screen (stretch) | Not started |

## Signal window (what the risk engine reads)

The backend [risk engine](risk-engine.md) takes raw signals, not a feature vector. The schema is `SignalWindow` in `backend/src/risk/types.ts`: `ts`, `face_visible`, `heart_rate`, `breathing_rate`, `engagement`, `eye_closure_frac`, `longest_eye_closure_s`, `yawns`, `emotion_stress`, `gaze_off_road_s`, `phone_in_hand`, `hard_brakes`, `swerves`, `speed_mph`, `speed_limit_mph`. Send null for anything unknown. There is no wire frame for it yet (see [risk-engine.md](risk-engine.md#integration)).

Until then, the older `risk_window.features` name → value map is stored by the backend and not read. The 13-feature vector from the root README (`eye_closure`, `long_blinks`, `yawns`, `head_nod`, …) is superseded by the signal window.

## Events the backend uses

Put these in `risk_window.events` for the window in which they happened:

- `yawn`, `nod`: roast call text ("yawned 3 times in 4 minutes") and the yawn count in answers
- `hard_brake`: pauses driver speech for 10 s
- `swerve`: stored only

## What the backend already handles

The phone does **not** need to implement any of these:

- Risk scoring and the decision tree (once the [risk engine](risk-engine.md) is wired in), including the kids-in-car tier bump
- Choosing and synthesizing what to say
- Group chat, guardian alerts, roast, permission prompt when sharing is off
- Parsing "I'm fine", yes/no, and "tell her …"

## Open protocol gaps

- No wire frame for a `SignalWindow`; the protocol still has `risk_window` (`R`, `drowsy`, `reckless`). The engine does cover `distracted` (gaze off road).
- No `trip_start` fields for `kids_in_car`, `low_experience` or `sleep_hours`. The engine needs them (the sleep term adds to the score only when hours are known). Medication and rested 1–5 are not used.
- No frame for per-driver feedback (`false_alarm` / `confirmed` for a `window_ts`) beyond `dismissed`.
