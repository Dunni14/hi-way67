# Android app

**Status: Not started.** No Android code is in this repository. This page specifies what the app must do so it fits the backend that already exists. The design comes from the [root README](../README.md); the wire format is in [protocol.md](protocol.md).

Planned stack: native Kotlin, Presage native SDK, Android `SpeechRecognizer`, installed over USB.

## Responsibilities

| # | Responsibility | Status |
|---|---|---|
| 1 | Full-screen dashcam view, front camera facing the driver, no touch needed while driving | Not started |
| 2 | Presage: blinks, eye closure, head pose and nods, expression, HR, HRV, breathing, confidence | Not started |
| 3 | 60 s baseline at trip start; score signals as deviation from it | Not started |
| 4 | 10 s rolling average; drop low-confidence frames and mark them missing | Not started |
| 5 | Feature vector **x** (13 features, each 0..1) every 10 s | Not started |
| 6 | Drowsy and reckless weight vectors → `r`, multiplier `m` (context × speed), `R = clamp(100·r·m)` | Not started |
| 7 | Decision tree: tiers 40/70/85, dominant sub-score, 15 s hold, 2 min per-tier cooldown, 70 sustained 2 min → 85 | Not started |
| 8 | GPS speed and location; IMU hard-brake and swerve detection | Not started |
| 9 | WebSocket client: `hello` on connect, `risk_window` every 10 s, `alert`, `settings`, `trip_start` / `trip_end` | Not started |
| 10 | Play `speak.audio` (base64 mp3), or on-device TTS when it is empty | Not started |
| 11 | Listen for `listenAfterMs` after a `speak`, send `utterance` with the same `context`, then `speak_done` | Not started |
| 12 | `navigate` → open maps searching "rest stop" | Not started |
| 13 | `dismissed` → gradient step on **w** toward lower risk for the latest window; show weights on a debug screen | Not started |
| 14 | Settings: sharing mode, kids in car | Not started |
| 15 | Pre-trip check screen (stretch) | Not started |
| 16 | Bundled alarm audio for the alarm stage | Not started |
| 17 | Report card screen (stretch) | Not started |

## Feature vector (from the root README)

```
x = [ eye_closure, long_blinks, yawns, head_nod, breathing_dev, heart_rate_dev,
      emotion_stress, hard_brake_count, swerve_count, speed_over_limit,
      sleep_deficit, hours_driving, night_time ]
```

Send it in `risk_window.features` as a name → value map. The backend stores it and does not read it.

## Events the backend uses

Put these in `risk_window.events` for the window in which they happened:

- `yawn`, `nod`: roast call text ("yawned 3 times in 4 minutes") and the yawn count in answers
- `hard_brake`: pauses driver speech for 10 s
- `swerve`: stored only

## What the backend already handles

The phone does **not** need to implement any of these:

- Kids-in-car tier bump (70 → 85)
- Choosing and synthesizing what to say
- Group chat, guardian alerts, roast, permission prompt when sharing is off
- Parsing "I'm fine", yes/no, and "tell her …"

## Open protocol gaps

- No `distracted` sub-score or gaze event, though the README defines a distracted state.
- No fields for pre-trip answers (rest, sleep, medication, experience). They would only feed the phone-side score, so they may not need to be sent.
- No message to report a weight change back to the backend for logging.
