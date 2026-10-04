# Frontend agent: Driver Guardian Android app

You build and maintain the **frontend**: the native Android app that sits on the dash, watches the driver, and reports to the backend. This file is the brief. [README.md](README.md) says how to build and run it; [../docs/risk-engine.md](../docs/risk-engine.md) and [../backend/PROTOCOL.md](../backend/PROTOCOL.md) define what it talks to.

**Status:** built and compiling. Core loop, phone-side scoring, backend risk-engine client (trips, windows, feedback, report, history), settings, debug, alarm. Not yet run on a device.

## Scope

| Plan point | Status | Notes |
|---|---|---|
| 1. Driver sensing (Presage) | Done, untested on a face | Fake source for demos. |
| 2. Pre-trip check | **Excluded** | No questionnaire. Three plain settings instead: kids in car, new driver, hours slept (optional). They go to the engine at trip start. |
| 3. Risk score | **Backend engine first**, phone model as fallback | See "Who scores". |
| 4. Decision tree | Engine owns it when on; `AlertGate` is the fallback | |
| 5. Voice | **Excluded** | `speak` frames are received and ignored. No mic, no TTS, no `RECORD_AUDIO`. |
| 6. Photon agent | Backend only | The app sends `sharingMode` and `kidsInCar`. |
| 7. Trip log and report card | Done | Local card plus the engine's report, and a history screen. |
| 8. Surroundings | Stretch, not started | Fixed 65 mph limit. |

Cut by the plan: Health Connect, landing page, weight fitting, rear-camera YOLO, voice cloning, event map, Spotify.

## Who scores

The backend's logistic engine is the source of truth. The app sends raw signals, not a score.

| Rule | Owner |
|---|---|
| Baseline (first 6 windows), smoothing, levels, score `R`, tier, holds, overrides, cooldowns, kids raise | **Backend engine** |
| Voice and iMessage for an engine alert | Backend (`onRiskEvaluation`) |
| Alarm audio on `voice_urgent` | **App** |
| Per-driver weight change from feedback | Backend engine (x0.95 / x1.05, clamped 0.5 to 1.5) |
| 60 s calibration, 10 s window of raw signals, IMU events | **App** |
| Phone score, `AlertGate`, `alert` frames | **App, only when the engine is off or unavailable** |

**Never both.** While the engine scores a trip the app does not send `alert` frames. The backend would speak for the engine's alert and again for the phone's. `risk_window` frames still go over the WebSocket for logging.

Fallback triggers: the setting is off, `POST /trips` fails (backend without `DATABASE_URL`, or unreachable), or a window post fails. Fallback never blocks sensing.

## Stack

Kotlin, Gradle Kotlin DSL, `minSdk 28` (Presage), Jetpack Compose (single activity), CameraX, Presage SDK, OkHttp (WebSocket and REST), kotlinx.serialization, coroutines and Flow, FusedLocation, SensorManager, MediaPlayer for the alarm, DataStore for settings. Installs over USB.

No third-party key reaches the phone except `PRESAGE_API_KEY` from `local.properties`. No ElevenLabs, OpenRouter or Photon keys.

## Code map

```
core/src/main/kotlin/dg/core/
  Frames.kt      WebSocket frames, mirrors backend/src/ws/protocol.ts
  Rest.kt        REST bodies and responses, mirrors backend/src/risk/types.ts
  Signals.kt     PresageFrame, Baseline, smoothers, TripEngine (emits RiskWindow and SignalWindowBody)
  Risk.kt        Phone-side feature vector, weights, RiskModel (fallback)
  Gate.kt        AlertGate (fallback)
  ReportCard.kt  Local report card
  DemoScript.kt  Scripted demo signals
app/src/main/java/dev/driverguardian/
  trip/TripController.kt   Trip lifecycle, window loop, engine queue, feedback, history
  net/BackendClient.kt     WebSocket, reconnect, buffered windows
  net/RiskApi.kt           REST client
  sensing/                 PresageSource, MotionSource
  data/SettingsStore.kt    DataStore settings
  ui/Screens.kt            Dashcam, History, Report card, Settings, Debug
  alarm/AlarmPlayer.kt
```

`core/` has no Android imports so it is unit tested on the JVM.

## Signals sent to the engine

Per 10 s window (`SignalWindowBody`, backend names). Null means not measured; never send 0 for a missing signal.

| Field | Source |
|---|---|
| `face_visible` | Any usable Presage frame in the window |
| `heart_rate`, `breathing_rate`, `emotion_stress` | Presage, 10 s mean |
| `eye_closure_frac` | Presage, 60 s mean share of eyes closed |
| `longest_eye_closure_s` | Longest unbroken closure (eye >= 0.7 or long blink), 1 s resolution. Drives the microsleep override at 1.5 s. |
| `yawns` | Count in the window |
| `engagement` | `1 - gaze off road share` |
| `gaze_off_road_s` | Gaze-off share x 10 |
| `hard_brakes`, `swerves` | IMU counts |
| `speed_mph`, `speed_limit_mph` | GPS, fixed 65 mph |
| `phone_in_hand` | Not detected, always null |

`ts` is ISO 8601 UTC at the end of the window and must be unique per trip (a duplicate gets 409). Low-confidence Presage frames are dropped before any of this.

## Trip flow rules

1. Start: connect the WebSocket, `POST /trips`, begin the 60 s calibration. Windows are queued while the trip id is pending, in order, newest kept if the queue overflows.
2. Calibration windows are still posted (the engine builds its own baseline from the first 6), but the UI shows "Calibrating…" and no engine verdict.
3. Each response updates the display: score, tier, dominant factor, override, actions, degraded flag.
4. `voice_urgent` plays the alarm. `dismissed` (WebSocket) or a **False alarm** tap stops it. The `dismissed` nudge to the phone's local weights still applies for the fallback model.
5. Feedback buttons apply to the latest window that raised a voice action, and only show while parked.
6. End: stop sensing, drain the queue, `POST /trips/{id}/end`, `GET /trips/{id}/report`. Show the local card immediately; add the engine report when it arrives. A failure here is logged and the local card still shows.
7. History: `GET /drivers/{id}/trips`. The driver id is a UUID generated on first run and kept in settings.

## Backend client

WebSocket `ws://<host>/phone`, REST `http://<host>/...`, same host:port, no auth. One phone connection at a time; a new one closes the old with code `4000` and the app does **not** reconnect on 4000. Frames sent: `hello` (every connect), `settings`, `trip_start`, `risk_window` every 10 s, `alert` (fallback only), `trip_end`. Frames received: `dismissed`, `navigate`, `error`, `speak` (ignored). Decode with `ignoreUnknownKeys` so new frames never crash the app. REST errors: 400 bad body, 404 unknown trip (or engine off), 409 ended trip or duplicate `ts`.

## UI rules

**The driver never touches the screen while driving.** Full-screen dashcam, screen on, immersive. Settings, History, Debug, feedback buttons and End trip are disabled above 3 mph. Show "Can't see driver" and "Signals degraded" instead of a made-up score. Status text next to the connection dot says whether the engine or the phone is scoring.

## Permissions

`CAMERA`, `ACCESS_FINE_LOCATION`, `INTERNET`, `WAKE_LOCK`. No `RECORD_AUDIO`. Ask on first launch while parked.

## Tests and done means

JVM tests (`./gradlew :core:test`): phone `RiskModel` and `AlertGate` rules, frame shapes, REST body field names, response parsing, signal extraction (longest eye closure, yawn count, speed, ISO `ts`).

Done means:
- With the engine on, a trip shows engine scores and tiers, and the backend sees no duplicate `alert`.
- With the backend started without `DATABASE_URL`, the app falls back to phone scoring and still reaches 40, 70, 85 in demo mode.
- Feedback shows the new weight multiplier. End trip shows the engine grade. History lists the trip.
- No code path touches excluded work (mic, TTS, pre-trip questionnaire), and no secrets are in the app.

Still to verify on a device: live Presage signals, the REST path against a running backend, and the alarm at `voice_urgent`.

## Known gaps

- No `distracted` field in the WebSocket protocol; the engine's `distracted` level only sees `gaze_off_road_s`, which the Presage SDK does not provide yet.
- `phone_in_hand` and a real speed limit are not available.
- The app does not retry a failed `end` or `report` call.
- The weight change from the phone's `dismissed` nudge is not reported to the backend.

## Safety

A driver aid, not a medical device. It does not replace rest and never controls the vehicle. Nothing in the UI may require interaction while moving or block the view of the road.
