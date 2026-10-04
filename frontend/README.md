# Driver Guardian: Android app

The phone on the dash. It watches the driver with Presage, measures speed and motion, and sends 10 s windows to the backend. The backend's [risk engine](../docs/risk-engine.md) scores them and decides what happens. If the engine is off or unreachable, the app falls back to scoring on the phone.

Design brief and rules: [frontend.md](frontend.md). Wire formats: [../backend/PROTOCOL.md](../backend/PROTOCOL.md) (WebSocket) and [../docs/risk-engine.md](../docs/risk-engine.md) (REST).

## Layout

| Path | What |
|---|---|
| `core/` | Pure Kotlin/JVM, no Android. Frames, REST models (`Rest.kt`), signals/baseline/smoothing, the phone-side `RiskModel` and `AlertGate`, the scripted demo, local report card, JVM tests. |
| `app/` | Android shell. CameraX preview, `BackendClient` (WebSocket), `RiskApi` (REST), GPS/IMU, alarm, Compose UI, `TripController`. |
| `../android/` | Standalone Presage SmartSpectra demo. Reference for the SDK setup. Not part of this Gradle build. |

## How a trip runs

```
Presage + GPS + IMU ─► TripEngine (10 s window) ─┬─► RiskApi  POST /trips/{id}/windows ─► score, tier, actions
                                                  └─► BackendClient  risk_window frame (logging, legacy path)
```

1. **Start trip.** `POST /trips` with the driver id, kids-in-car, new-driver, sleep hours and sharing mode. The engine returns a `trip_id`.
2. **Every 10 s.** The app posts the window's raw signals (heart rate, breathing, eye closure, longest closure, yawns, stress, gaze off road, hard brakes, swerves, speed, speed limit). Windows go through a queue so they arrive in order.
3. **Show the verdict.** The dashcam shows the engine's score and tier, why it fired (microsleep, sustained drowsiness, dominant factor), whether guardians were notified or asked, and a "degraded" warning when the face is not clear.
4. **Alarm.** The bundled alarm plays when the engine returns `voice_urgent`. The backend maps the same actions to voice and iMessage, so the phone does **not** send its own `alert` frame while the engine is scoring (it would speak twice).
5. **Feedback.** After an alert, while parked, two buttons send `false_alarm` or `confirmed`. The engine scales that factor's weight for this driver (x0.95 / x1.05, clamped 0.5 to 1.5) and the app shows the new multiplier.
6. **End trip.** `POST /trips/{id}/end`, then `GET /trips/{id}/report`. The report screen shows the local card plus the engine's grade, time per tier and tier events.
7. **History.** The History screen lists past trips and grades (`GET /drivers/{id}/trips`).

**Fallback.** If `POST /trips` fails (no `DATABASE_URL` on the backend, network down) or the engine setting is off, the phone's own `RiskModel` and `AlertGate` score the trip and send `alert` frames as before. A window the engine fails to score is covered by the phone gate until the next one lands. The status next to the connection dot says `engine` or `phone scoring`.

## Screens

- **Dashcam.** Dimmed camera, big score, tier colour, drowsy and reckless bars, engine status, feedback buttons (parked only).
- **History.** Past trips with grade and peak score.
- **Report card.** After End trip.
- **Settings.** Host, driver name, sharing mode, kids in car, new driver, hours slept, engine on/off, demo mode.
- **Debug.** Engine verdict and levels, phone score, features and weights, gate timers, last frames.

## Build and test

Needs JDK 17 to 21 (not 25), a `PRESAGE_API_KEY` line in `local.properties` (see `local.properties.example`) and an Android SDK (`sdk.dir=...`).

    export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
    ./gradlew :core:test          # JVM unit tests
    ./gradlew :app:assembleDebug  # app/build/outputs/apk/debug/app-debug.apk

## Run against the backend

    cd ../backend
    DATABASE_URL=postgres://... NO_SPECTRUM=1 npm run dev

Without `DATABASE_URL` the REST engine is off and the app scores on the phone. Set the host in Settings (default `10.0.2.2:8787` for the emulator; the laptop's LAN IP for a USB phone). The same host:port serves both the WebSocket and REST.

Demo mode is on by default: scripted driver signals at a fake 65 mph. After the 60 s calibration the phone path fires tiers 40, 70, 85 at roughly 3:00, 3:40 and 4:40. With the engine on, tiers follow the engine's own rules (the first 6 windows set its baseline).

## Not done yet

- Presage on a real face: `SmartSpectraPresageSource` compiles but is untested on a device. The SDK gives pulse, breathing, blinks and expression scores only. Yawn, nod, gaze and eye-closure ratio stay unset, so the engine sees those signals as missing.
- `phone_in_hand` is never sent (no detector). The engine treats it as no evidence.
- The speed limit sent to the engine is the fixed 65 mph demo constant.
- `alarm.wav` is a generated placeholder tone.
- No instrumented or UI tests. The REST path is covered by codec tests only; it has not been run against a live backend or on a device. The app compiles and the `core` tests pass.
