# Driver Guardian Android app: agent instructions

Native Kotlin app (`com.example.coolvitals`, display name "CoolVitals"). It runs the Presage SmartSpectra SDK on the front camera. Repo-wide rules are in [`../AGENTS.md`](../AGENTS.md); the target behavior is specified in [`../docs/phone-app.md`](../docs/phone-app.md).

## Current state

There is one screen, `MainActivity.kt`: a front-camera preview with a debug overlay showing SmartSpectra's cardio and face metrics:

- **HUD** (top left): heart rate and confidence, eyes open or closed, % of the last 60 s with eyes closed, blinks per minute, talking, top expression, eye aspect ratio (EAR) and mouth openness.
- **`FaceMeshView`** (top right): the landmark mesh, auto-rotated and mirrored. Green dots mean stable, orange unstable; eyes, mouth and irises are cyan.
- **`SparklineView`** (bottom): a rolling 60 s heart-rate graph.
- **`FaceGeometry.kt`**: EAR and mouth-open ratio from the landmarks. It assumes the MediaPipe 478-point indexing. `FaceStats.kt` keeps the rolling blink statistics.

It does not yet:

- connect to the backend WebSocket
- compute features or the risk score, or run the decision tree
- play audio or run speech recognition (no `RECORD_AUDIO` permission yet)
- read GPS or the IMU

Update this section and `../docs/status.md` as those land.

## Build and run

- **Requirements:** JDK 17, Android SDK 36, and a physical device with a front camera (min SDK 28). Presage does not work in the emulator.
- **Setup:** copy `local.properties.example` to `local.properties`, then set `sdk.dir` and `PRESAGE_API_KEY`.
- **Build:** `./gradlew assembleDebug` (`gradlew.bat assembleDebug` on Windows).
- **Install on a USB-connected device:** `./gradlew installDebug`.
- **Logs:** `adb logcat -s SmartSpectra`.

Toolchain: Gradle 8.14 (wrapper), AGP 8.13, Kotlin 2.2, `com.presagetech:smartspectra:3.4.0` from `https://maven.presagetech.com/releases`. Repositories are declared only in `settings.gradle.kts` (`FAIL_ON_PROJECT_REPOS`).

## Conventions

- `PRESAGE_API_KEY` reaches the code only through `BuildConfig.PRESAGE_API_KEY`, which `app/build.gradle.kts` fills from `local.properties`. Never hard-code it or commit `local.properties`.
- SmartSpectra only reports breathing unless you ask for more. Add any metric you need to `requestedMetrics`.
- Face data API, as used in Presage's demo app: `metrics.hasFace()`, then `metrics.face.blinkingList` / `talkingList` (each item has `.detected`), `expressionList` (`.scoresList` → `.type: ExpressionType`, `.confidence` in percent), and `landmarksList` (`.valueList` of points with `.x`/`.y`, plus `.stable`). Each metrics packet carries a short batch; use `.last()` for the current state.
- Observe SDK `LiveData` (`metrics`, `validationStatus`, `processingStatus`, `error`) from the activity. Stop the SDK in `onDestroy` with `NonCancellable`, as the existing code does.
- Treat readings with low confidence, or a validation code other than `OK`, as missing data (see the root README §1).

## Talking to the backend

- **Endpoint:** `ws://<laptop-ip>:8787/phone`. The phone and the laptop must be on the same network.
- **Protocol:** [`../backend/PROTOCOL.md`](../backend/PROTOCOL.md), with the full version in [`../docs/protocol.md`](../docs/protocol.md). Its source of truth is `../backend/src/ws/protocol.ts`. Match it exactly; don't invent new message types without changing the backend too.
- **Backend-only work:** choosing what to say, ElevenLabs, iMessage and the roast. The app plays the `speak.audio` mp3 it receives, falls back to on-device TTS when `audio` is empty, and sends `speak_done` when finished.
- **No API keys:** no ElevenLabs, OpenRouter or Spectrum keys on the phone.
- **Testing without the phone:** `npm run fake-phone -- -i` in `../backend` simulates this app.
