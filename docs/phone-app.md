# Android app

There are two Android projects:

- **[`frontend/`](../frontend): the Driver Guardian app.** It handles sensing, the risk score, the decision tree, alarm, report card, voice playback and mic replies, and it talks to the backend. Brief: [`frontend/frontend.md`](../frontend/frontend.md); build and run: [`frontend/README.md`](../frontend/README.md). Status: [status.md](status.md) (rows marked **Built**).
- **[`android/`](../android): CoolVitals**, the standalone Presage demo with the face-metrics debug overlay. It's kept as an SDK reference and doesn't talk to the backend. The rest of this page describes it, together with the original phone spec that `frontend/` implements.

**CoolVitals status: Partial (prototype).** The design comes from the [root README](../README.md); the wire format is in [protocol.md](protocol.md). Build instructions: [`android/AGENTS.md`](../android/AGENTS.md).

Stack: native Kotlin, Presage SmartSpectra SDK 3.4.0, min SDK 28 / target 36, installed over USB. Planned additions: Android `SpeechRecognizer`, OkHttp (or similar) for the WebSocket.

## Current state

One activity, [`MainActivity.kt`](../android/app/src/main/java/com/example/coolvitals/MainActivity.kt), shows a full-screen front-camera preview with a status label on top.

- **Startup:** asks for camera permission, then starts SmartSpectra with `cardioMetrics + breathingMetrics + faceMetrics`.
- **Debug overlay:**
  - a HUD with heart rate, eyes open or closed, % of the last 60 s with eyes closed, blinks per minute, talking, top expression, eye aspect ratio and mouth openness
  - a face landmark mesh inset (`FaceMeshView`)
  - a 60 s heart-rate graph (`SparklineView`)
  
  Eye and mouth ratios come from the landmarks in `FaceGeometry.kt`, assuming the MediaPipe 478-point layout. They're the starting point for yawn detection, but nothing thresholds them yet.
- **Validation:** shows the SDK's hint when validation fails, and "Hold still, measuring..." until the first reading arrives.
- **Errors:** logs SDK errors under the `SmartSpectra` tag and shows them on screen.
- **Shutdown:** stops the SDK in `onDestroy`.
- **API key:** the Presage key comes from `local.properties` via `BuildConfig.PRESAGE_API_KEY`.

There is no networking (the `INTERNET` permission is only used by Presage), scoring, audio, speech or location yet.

## Responsibilities

| # | Responsibility | Status |
|---|---|---|
| 1 | Full-screen dashcam view, front camera facing the driver, no touch needed while driving | Partial: full-screen preview exists; no driver-facing UI yet |
| 2 | Presage: blinks, eye closure, head pose and nods, expression, HR, HRV, breathing, confidence | Partial. HR, breathing, a blink-based eye closure share, stress from expression and face visibility go into each Drive screen window; see [drive-screen.md](drive-screen.md#presage). No yawns, nods, gaze or microsleep yet |
| 3 | 60 s baseline at trip start; score signals as deviation from it | Not started |
| 4 | 10 s rolling average; drop low-confidence frames and mark them missing | Partial: validation status handled; no averaging, confidence not used to filter |
| 5 | Feature vector **x** (13 features, each 0..1) every 10 s | Not started |
| 6 | Drowsy and reckless weight vectors → `r`, multiplier `m` (context × speed), `R = clamp(100·r·m)` | Not started |
| 7 | Decision tree | Moved to the backend risk engine (the phone sends raw signals; see [architecture.md](architecture.md#who-owns-the-decision-tree)) |
| 8 | GPS speed and location; IMU hard-brake and swerve detection | Not started |
| 9 | WebSocket client: `hello` on connect, `risk_window` every 10 s, `alert`, `settings`, `trip_start` / `trip_end` | Not started. The Drive screen uses the REST path instead (`POST /trips`, `/windows`, `/end`), see [drive-screen.md](drive-screen.md#backend-link). The WebSocket is still needed for `speak` / `utterance` |
| 10 | Play `speak.audio` (base64 mp3), or on-device TTS when it is empty | Not started |
| 11 | Listen for `listenAfterMs` after a `speak`, send `utterance` with the same `context`, then `speak_done` | Not started |
| 12 | `navigate` → open maps searching "rest stop" | Not started |
| 13 | `dismissed` → gradient step on **w** toward lower risk for the latest window; show weights on a debug screen | Not started |
| 14 | Settings: sharing mode, kids in car | Not started |
| 15 | Pre-trip check screen (stretch) | Not started |
| 16 | Bundled alarm audio for the alarm stage | Not started |
| 16b | `play_sound` → play `res/raw/<id>.mp3` (`rooster`, `airhorn`, `goat`) once, then continue normally; no reply | Built in `frontend/` (`alarm/SoundPlayer.kt`). Falls back to `res/raw/alarm.wav` until the three sound files are added |
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
