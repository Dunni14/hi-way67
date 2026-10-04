# Driver Guardian: Android app

Brief: [frontend.md](frontend.md). Wire format: [../backend/PROTOCOL.md](../backend/PROTOCOL.md).

- `core/`: pure Kotlin/JVM, no Android. Frames, signals/baseline/smoothing, `RiskModel`, `AlertGate`, scripted demo, JVM tests.
- `app/`: Android shell. CameraX preview, OkHttp `BackendClient` (reconnect, buffered windows), GPS/IMU, alarm, Compose UI (dashcam, debug, settings).

## Build and test

Needs JDK 17–21 and an Android SDK (`local.properties` with `sdk.dir=...`).

    ./gradlew :core:test          # JVM unit tests
    ./gradlew :app:assembleDebug  # app/build/outputs/apk/debug/app-debug.apk

## Run against the backend

    cd ../backend && NO_SPECTRUM=1 npm run dev

Set the host in the app's Settings (default `10.0.2.2:8787` for the emulator; use the laptop's LAN IP for a USB phone).
Demo mode is on by default: scripted driver signals at a fake 65 mph. After the 60 s calibration, tiers 40, 70, 85 fire
at roughly 3:00, 3:40 and 4:40 into the trip. Turn demo mode off to use real GPS and IMU.

## Trip start and report card

The idle dashcam screen has the two context toggles (kids in car, low experience) and shows the resulting risk multiplier. Low experience is phone-only; it is not sent to the backend. When a trip ends, `ReportScreen` shows a letter grade, one line of advice, a risk-over-time chart and event counts (`core/Report.kt`).

## Not done yet

- Real Presage SDK: `PresageSource` has only the scripted and empty implementations. With demo mode off the app shows "Can't see driver".
- `alarm.wav` is a generated placeholder tone.
- Stretch items (report card, weather) and instrumented/UI tests.
- Not run on a device or emulator; only compiled.
