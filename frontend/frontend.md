# Frontend agent: Driver Guardian Android app

You are the agent that builds and maintains the **frontend** of Driver Guardian: the native Android app that sits on the dash, watches the driver, scores drowsiness and recklessness, runs the phone half of the decision tree, and reports to the backend over a WebSocket.

> **Superseded in part (2026-10-04): scoring moved to the backend.** The app no longer computes `R`, runs an alert gate or nudges weights; it sends raw signals (`risk_window.signals`) and displays the backend risk engine's `evaluation`. Sections 3 (Risk score) and 4 (Decision tree), the `RiskModel` / `AlertGate` parts of the architecture, state and test lists below describe the removed phone scorer. Current design: [docs/architecture.md](../docs/architecture.md), wire format: [docs/protocol.md](../docs/protocol.md).

This file is your brief. It is derived from [`docs/architecture.md`](../docs/architecture.md) (component boundaries, who owns what, data flows, state) and the root [`README.md`](../README.md) (the project plan). Wire format: [`docs/protocol.md`](../docs/protocol.md) and [`backend/PROTOCOL.md`](../backend/PROTOCOL.md). Source of truth for frames: [`backend/src/ws/protocol.ts`](../backend/src/ws/protocol.ts).

**Status of the frontend: first pass built.** `core/` (logic, JVM tests) and `app/` (Android shell) exist in `frontend/`; see `README.md` for what is not done yet. The sections below remain the spec.

## Scope

The plan has eight numbered points. This brief covers six of them.

| Plan point | In scope? | Notes |
|---|---|---|
| 1. Driver sensing (Presage) | **Yes** | Core of the app. |
| 2. Pre-trip check | **No, excluded** | No pre-trip screen, no rested / sleep / medication / experience inputs. |
| 3. Risk score | **Yes** | Feature vector, weights, multiplier, `R`. |
| 4. Decision tree | **Yes** | Phone owns tiers, hold, cooldown, escalation, alarm audio. |
| 5. Voice through ElevenLabs | **Yes (playback + replies)** | Play `speak` audio, listen, send `utterance` / `speak_done`. See [Voice](#voice). |
| 6. Photon agent | Partial | Backend-only. The app only sends `sharingMode` and `kidsInCar`. |
| 7. Trip log and report card | Partial | App streams windows to the backend. Report card screen is stretch. |
| 8. Surroundings | Stretch | GPS speed vs fixed limit, weather, night driving. |

### Excluded work (do not build)

- **Pre-trip check (point 2).** No screen, no inputs, no storage. The features that depend on it (`sleep_deficit`, and the medication and experience terms of the context vector) are **fixed at neutral defaults** (see [Feature vector](#feature-vector)). Do not add protocol fields for them.
- Also cut by the plan itself: Health Connect import, landing page, least-squares weight fitting, rear-camera YOLO, voice cloning, event map, Spotify.

Voice was originally excluded and is now in scope (see [Voice](#voice)). The **bundled alarm file** for the alarm stage (README §4) stays separate from it.

The kids-in-car toggle comes from the pre-trip list in the plan, but the protocol (`hello` / `settings`), the backend tier bump and demo step 3 all need it, so it stays as a plain setting, not a questionnaire. That is an assumption; drop it if the plan owner says otherwise.

## Responsibilities and boundaries

From architecture.md: **the phone reports and the backend acts.** The backend never computes risk; it trusts `R` and `tier` from the phone. The app must never hold a third-party secret. No ElevenLabs, OpenRouter or Photon keys ever reach the phone.

| Responsibility | Owner |
|---|---|
| Compute `R`, `drowsy`, `reckless` every 10 s | **App** |
| Map `R` to a tier (40 / 70 / 85), pick the dominant sub-score | **App** |
| 15 s hold, 2 min per-tier cooldown, "70 sustained 2 min → 85" | **App** |
| Weight nudge on `dismissed` | **App** |
| Kids-in-car bump (70 → 85) | Backend. Do **not** duplicate it in the tree. Kids-in-car only enters the app's multiplier `m`. |
| Tier → spoken line, guardian alert, roast, permission prompt | Backend |
| Parsing the driver's speech | Backend (and excluded here) |

If you are unsure who owns a rule, check architecture.md before writing code.

## Stack

- **Kotlin**, native Android, Gradle Kotlin DSL. `minSdk 28 (Presage SDK)`, `targetSdk` current.
- **Jetpack Compose** for UI. Single activity.
- **CameraX** for the front camera feed (preview plus analysis use case).
- **Presage native Android SDK** for on-device face and vitals.
- **OkHttp** WebSocket client. **kotlinx.serialization** for frames. **kotlinx.coroutines / Flow** for the pipeline.
- **FusedLocationProvider** for GPS. **SensorManager** accelerometer and gyroscope for IMU.
- **MediaPlayer** or **SoundPool** for the bundled alarm only.
- **DataStore** for settings.
- Installs over USB. No Apple signing, no Play Store packaging needed.

Project location: a standard Gradle project in `frontend/` (`frontend/app/…`). Keep this file at `frontend/frontend.md`.

## Architecture

```
┌──────────────────────────── Android app ────────────────────────────┐
│                                                                      │
│ CameraX front cam ─► PresageSource ─► SignalSmoother ─┐              │
│ Location ──────────► MotionSource (speed, lat/lon) ───┤              │
│ IMU ───────────────► ImuEventDetector (hard_brake,    ┤              │
│                                        swerve)         ▼             │
│                                              WindowAggregator (10 s) │
│                                                        ▼             │
│                                 FeatureBuilder ─► RiskModel          │
│                                  (x, 13 floats)   (w, m, R, drowsy,  │
│                                                    reckless)         │
│                                                        ▼             │
│                                               DecisionTree + Gate    │
│                                                 │              │     │
│                                       AlarmPlayer│             │     │
│                                                 ▼              ▼     │
│                                            BackendClient ◄── UI state│
└───────────────────────────────────────────────┬──────────────────────┘
                                                │ hello, settings, trip_start/end,
                                                │ risk_window (10 s), alert
                                                ▼
                                         Backend  ws://<host>:8787/phone
```

Package layout under `app/src/main/java/<pkg>/`:

```
sensing/    PresageSource, SignalSmoother, Baseline, MotionSource, ImuEventDetector
risk/       FeatureVector, WeightStore, RiskModel
tree/       DecisionTree, AlertGate
net/        BackendClient, Frames (serializable data classes), ReconnectPolicy
trip/       TripController (trip lifecycle, window loop)
ui/         DashcamScreen, DebugScreen, SettingsSheet, ReportCardScreen (stretch)
alarm/      AlarmPlayer (+ res/raw/alarm.mp3)
```

Keep `risk/` and `tree/` free of Android imports so they can be unit tested on the JVM with a fake clock.

## 1. Driver sensing (Presage)

The front camera faces the driver. Presage runs on device and yields about **1 Hz**:

- blinks, iris / eye tracking, eye closure
- face points: head pose, nodding
- expression, talking detection
- heart rate, HRV, breathing rate
- confidence and stability

Eyes are the primary drowsiness signal. Vitals are slow and noisy in a moving car, so they support the eye signals; they do not lead.

**Derived states**

| State | Signals |
|---|---|
| Drowsy | Share of time eyes closed over rolling 60 s rises; long slow blinks; yawning; head nodding; breathing slows and HR trends below baseline |
| Reckless / agitated | HR spike above baseline; stress or anger expression; confirmed by hard braking, sharp turns, speeding |
| Distracted | Gaze off road > 2 s; engagement drop without the drowsy vitals pattern |

**Implementation rules (all required)**

1. **Baseline.** At the start of every trip, record a **60 s baseline** (HR, breathing, blink rate, eye-closure share). Score everything as a deviation from it. Show "Calibrating…" and emit no alerts during this period. Persist nothing across trips; people differ.
2. **Smoothing.** Every signal passes a **10 s rolling average** so one blink never triggers an alert.
3. **Low confidence.** Drop frames below the Presage confidence threshold (bad light, head turned). Mark those signals **missing** (null, not zero). When eye signals are missing, lean on phone sensors, and surface "Can't see driver" on the dashcam view.
4. **Events.** Emit discrete events for the window they occurred in: `yawn`, `nod` (Presage), `hard_brake`, `swerve` (IMU). These strings are exact; the backend keys on them.
5. **Distracted.** Compute it internally for the debug view, but the protocol has **no `distracted` field or event**. Do not send one. See [Open protocol gaps](#open-protocol-gaps).

Keep `PresageSource` behind an interface (`Flow<PresageFrame>`) with a **fake implementation** that replays scripted signals, so the pipeline and the demo run without the SDK or a face.

## 3. Risk score

Every 10 s window produces a feature vector **x**, each element normalized to 0..1:

```
x = [ eye_closure, long_blinks, yawns, head_nod, breathing_dev, heart_rate_dev,
      emotion_stress, hard_brake_count, swerve_count, speed_over_limit,
      sleep_deficit, hours_driving, night_time ]
```

### Feature vector

Use these exact names as the keys of `risk_window.features`. The backend stores the map and does not read it.

| Feature | Source | Normalization |
|---|---|---|
| `eye_closure` | Presage, share of 60 s eyes closed | deviation from baseline, clamp 0..1 |
| `long_blinks` | Presage | rate vs baseline, clamp |
| `yawns` | Presage | yawns in last 4 min, `min(n/4, 1)` |
| `head_nod` | Presage | nods in last 2 min, `min(n/4, 1)` |
| `breathing_dev` | Presage | slowing vs baseline, clamp |
| `heart_rate_dev` | Presage | absolute deviation from baseline, clamp |
| `emotion_stress` | Presage expression | stress / anger probability |
| `hard_brake_count` | IMU | in window, `min(n/2, 1)` |
| `swerve_count` | IMU | in window, `min(n/2, 1)` |
| `speed_over_limit` | GPS | `clamp((speed - limit) / 20)`; limit is a fixed demo constant |
| `sleep_deficit` | **excluded (pre-trip)** | **constant 0** |
| `hours_driving` | trip clock | `min(hours / 4, 1)` |
| `night_time` | local clock | 1 between 22:00 and 05:00, ramped at the edges |

A missing feature (low confidence) is left out of the dot product rather than treated as 0. Renormalize the remaining weights so a half-blind window is not artificially low.

### Scores

Two weight vectors over the same **x** give two sub-scores, so the tree knows which one fired:

```
r_drowsy   = w_drowsy   · x
r_reckless = w_reckless · x
r          = max(r_drowsy, r_reckless)
```

**Multiplier.** Speed and context raise the stakes of existing risk; they do not create it:

```
m = (1 + c · k) * (1 + b * v)
    k = context vector: kids_in_car, low_experience, medication
    v = min(speed_mph / 70, 1.5)
R = clamp(100 * r * m, 0, 100)
```

With point 2 excluded, only `kids_in_car` is live (from settings). `low_experience` and `medication` are **0**. Choose `c` and `b` so three yawns in four minutes at 70 mph scores far higher than the same yawns at 20 mph, and cover that with a unit test.

The frame's `drowsy` and `reckless` are the sub-scores scaled the same way to 0..100: `drowsy = clamp(100 * r_drowsy * m)`, `reckless = clamp(100 * r_reckless * m)`.

### Weights

- **Tonight:** hand-set weights in code (`WeightStore.defaults`). Drowsy leans on eye features, reckless on HR spike plus IMU events. Tune against the fake Presage script so the demo hits 40 / 70 / 85 on cue.
- **Live adaptation.** On `dismissed`, take one small gradient step on `w` toward lower risk for the **latest window**:
  ```
  w ← max(0, w − η * x_latest)      (the dominant sub-score's w)
  ```
  Start with `η = 0.02`. Keep the latest window's `x` and dominant sub-score in memory. The debug screen must **show the weights shifting** (before/after bars or a live table). This is demo step 4.
- **Not building:** ridge regression fitting. Roadmap only.

## 4. Decision tree

The app decides when to fire an `alert`. The backend decides what happens next.

```
R < 40                  → nothing (still send the risk_window)
40 ≤ R < 70             → alert {tier: 40, dominant}
70 ≤ R < 85             → alert {tier: 70, dominant}
R ≥ 85, or 70+ for 2min → alert {tier: 85, dominant}
```

`dominant` is `drowsy` if `drowsy >= reckless`, else `reckless`.

**Gates (all required, in `AlertGate`, with an injectable clock)**

1. **15 s hold.** A tier must hold continuously for 15 s before the alert fires. Dropping below the tier resets the timer.
2. **2 min cooldown per tier.** After firing tier T, do not fire T again for 120 s. Cooldowns are independent per tier, so escalating from 40 to 70 is not blocked by the 40 cooldown. The backend has **no cooldown of its own** and acts on every `alert`, so this gate is the only protection against spam.
3. **Sustained escalation.** If `R` stays in the 70 band for 120 s continuously, fire tier 85.
4. **No kids-in-car bump here.** The backend does it (70 → 85). Sending 70 with kids in the car is correct.
5. **Calibration.** No alerts during the 60 s baseline.

**Alarm stage.** When tier 85 fires, `AlarmPlayer` plays **one loud bundled audio file** (`res/raw/alarm.mp3`, include a placeholder) on the alarm stream. No music API. One play per 85 alert.

**Dismissal.** The driver says "I'm fine" (parsed by the backend), and the backend sends `{"type":"dismissed"}`. On receipt: stop the alarm if playing, apply the weight nudge, and leave cooldowns running.

## 6. Photon agent: the app's part

The agent is entirely backend. The app only owns the **sharing controls**:

| Mode | Wire value |
|---|---|
| Always share state | `"always"` |
| Share only on high risk | `"high_only"` (default) |
| Never share | `"never"` |

Plus **Kids in car** (`kidsInCar`). It feeds the multiplier `k` locally **and** goes to the backend for its 70 → 85 bump. Demo step 3 flips it live, so show the current `m` on the debug screen.

These live in a small settings sheet reachable by a deliberate tap while parked. Persist with DataStore and send `settings` immediately on change.

## 7. Trip log and report card

The backend stores every window; the app's job is to **send each 10 s `risk_window` reliably**.

- Buffer windows in memory while the socket is down (cap about 30 min, drop oldest) and flush in order on reconnect.
- **Stretch:** report card screen after `trip_end`: risk over time as a line chart, a letter grade, one sentence of advice, computed locally from the windows the app held. Weekly trends are out of scope.

## 8. Surroundings (stretch)

- GPS speed vs a **fixed demo speed limit** (a constant, no lookup API).
- Weather from **Open-Meteo** (free, no key): rain, snow, low visibility.
- Time of day / night driving.

Fold these into a single `surroundings_risk` input feeding `night_time` and `speed_over_limit`. Do this only after the core loop works.

## Backend client

Endpoint `ws://<backend-host>:8787/phone`. Make the host configurable (settings field and `BuildConfig` default). There is no auth. Only one phone connection is kept; a new one closes the previous with code `4000`, so **do not auto-reconnect on 4000**.

### Frames the app sends

| Frame | When |
|---|---|
| `hello` `{driverName?, sharingMode, kidsInCar}` | On every (re)connect |
| `settings` `{sharingMode?, kidsInCar?}` | When a toggle changes |
| `trip_start` | Trip begins (a `risk_window` with no trip auto-starts one, but send it explicitly) |
| `risk_window` `{ts, R, drowsy, reckless, speed, lat?, lon?, events, features}` | Every 10 s |
| `alert` `{tier, dominant, R}` | When the decision tree fires |
| `trip_end` | Trip ends. The backend posts the summary and clears state. |

`ts` is epoch ms at the **end** of the window. `speed` is mph (under 3 mph for a full minute counts as "stopped" on the backend). `events` ⊆ `yawn | nod | hard_brake | swerve`. `R`, `drowsy`, `reckless` are 0..100. `tier` is `40`, `70` or `85`; `dominant` is `drowsy` or `reckless`.

### Frames the app receives

| Frame | Handling |
|---|---|
| `dismissed` | Weight nudge, stop alarm |
| `navigate` `{query}` | `ACTION_VIEW` intent with `geo:0,0?q=<query>` |
| `error` `{message}` | Log |
| `speak` `{id, text, tier, audio, listenAfterMs, context}` | `VoicePlayer`: play `audio` (mp3), or on-device TTS if empty; listen `listenAfterMs` and send `utterance` with the same `context`; always send `speak_done`. |

Decode with `ignoreUnknownKeys = true` so new frames do not break the app.

### Reliability

- Reconnect with capped exponential backoff (1 s → 30 s). Re-send `hello` after every reconnect.
- Build frames from serializable classes in `net/Frames.kt` that mirror `protocol.ts` field for field. The backend validates with Zod and replies `error` to anything malformed.
- Never block the sensing pipeline on the network.

## Voice

The backend picks and synthesizes every line (ElevenLabs, key stays on the backend) and sends one `speak` at a time, waiting for `speak_done`. `voice/VoicePlayer.kt`:

1. Plays `audio` (base64 mp3) with `MediaPlayer`, or speaks `text` with `TextToSpeech` when `audio` is empty.
2. If `listenAfterMs > 0` and the mic is allowed, runs `SpeechRecognizer` for that long and sends `utterance {text, context}`. The backend parses "I'm fine", yes/no and "tell her …".
3. Always sends `speak_done {id}`, even on errors.

## UI

**The driver never touches the screen while driving.** The app is a full-screen dashcam view, plugged in, screen on.

- **Dashcam view (default).** Full-screen dimmed camera preview. Large readout of `R`, tier colour, drowsy / reckless bars, connection dot, "Calibrating…" and "Can't see driver" states. `FLAG_KEEP_SCREEN_ON`, immersive mode. No tap target that matters while moving.
- **Debug screen.** All 13 features, both `w` vectors with before/after on dismissal, current `m`, sub-scores, gate timers and cooldowns, backend status and last frames.
- **Settings sheet.** Sharing mode, Kids in car, driver name, backend host.
- **Report card (stretch).** See point 7.

Demo flow to support (README script): live signals and low score; kids-in-car toggle visibly changes `m`; fake yawning and nodding climbs the score through 40 → 70 → 85; "I'm fine" shifts the weights on the debug screen; alarm plays at 85.

## State

Per architecture.md, runtime state is process memory and short-lived.

| State | Where | Lifetime |
|---|---|---|
| Baseline | `Baseline` | Current trip |
| Smoothed signals, recent events | `SignalSmoother`, `WindowAggregator` | Current trip |
| Latest window `x` and dominant sub-score | `RiskModel` | Until the next window |
| Weights `w` | `WeightStore` (memory, reset to defaults on app start) | App process. Do not persist nudges, so the demo resets cleanly. |
| Gate timers, per-tier cooldowns | `AlertGate` | Current trip |
| Unsent window buffer | `BackendClient` | Until flushed, cap about 30 min |
| Sharing mode, kids in car, driver name, host | DataStore | Persistent |

One driver, one trip at a time, one backend connection.

## Permissions

`CAMERA`, `ACCESS_FINE_LOCATION`, `INTERNET`, `WAKE_LOCK`, `RECORD_AUDIO`. Request them on first launch while parked. Camera and location are required (clear failure state if denied); the mic is optional: without it the app speaks but can't hear replies.

## Build order

The plan's rule applies: **the core loop (camera → score → alert → backend) works end to end before anyone polishes anything.**

1. Gradle project, permissions, CameraX preview, keep-awake dashcam shell.
2. `BackendClient` with `hello`, reconnect, and a fake `risk_window` every 10 s. Check against `GET /health` and a running backend (`npm run dev` in `backend/`; `backend/src/dev/fakePhone.ts` is a reference client).
3. `PresageSource` (real SDK) plus the fake source and scripted demo replay.
4. Baseline, smoother, window aggregator, feature builder.
5. `RiskModel` with hand-set weights; debug screen showing `x`, sub-scores, `R`.
6. `DecisionTree` and `AlertGate` with the 15 s / 2 min / sustained rules. Send `alert`.
7. IMU events and GPS speed into the window.
8. `dismissed` weight nudge and weights view. Alarm audio at 85.
9. Settings sheet and `settings` frames. `navigate` handler.
10. Stretch: report card, weather, surroundings.

## Testing and acceptance

**Unit tests (JVM, no Android):**
- `RiskModel`: `R` clamped 0..100; same yawns score higher at 70 mph than at 20 mph; kids-in-car raises `m`; missing features renormalize.
- `AlertGate` with a fake clock: no fire before 15 s; reset on dip; one fire per 120 s per tier; the 40 cooldown does not block 70; 70 for 120 s fires 85; nothing fires during calibration.
- Dismissal: weights drop for the dominant sub-score and never go negative.
- Frames: serialization matches the shapes in `docs/protocol.md`.

**Integration:**
- Run the backend with `NO_SPECTRUM=1`, connect the app, drive the fake Presage script, and confirm the backend sees `hello`, a window every 10 s, and an `alert` at each tier.
- Restart the backend; confirm reconnect, `hello` re-sent, buffered windows flushed in order.

**Done means:**
- A scripted run produces tiers 40, 70, 85 on cue with the right `dominant`.
- The backend replies with no `error` frames.
- No code path touches excluded work: no pre-trip UI.
- No secrets in the app or `BuildConfig`.

## Open protocol gaps

Known, and not yours to patch unilaterally. Raise them rather than inventing fields:

- No `distracted` sub-score or gaze event, though the plan defines a distracted state.
- No message to report a weight change back to the backend for logging.
- Pre-trip answers have no protocol fields (and are excluded anyway).

## Safety

This is a driver aid, not a medical device. It does not replace rest and never controls the vehicle. Nothing in the UI should require interaction while the car is moving, and nothing may block the driver's view of the road.
