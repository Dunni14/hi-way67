# Driver Guardian: Android app

Brief: [frontend.md](frontend.md). Wire format: [../backend/PROTOCOL.md](../backend/PROTOCOL.md).

- `core/`: pure Kotlin/JVM, no Android. Frames (protocol mirror), `WindowAggregator` (raw signals per 10 s window), face geometry (eye closure, closure runs, yawns), scripted demo and `DemoClock`, report card, JVM tests. **No scoring**: the backend's risk engine scores every window and decides every alert.
- `../android/`: standalone Presage SmartSpectra demo (face-metrics overlay). Reference for the SDK setup the app uses; not part of this Gradle build.
- `app/`: Android shell, portrait. CameraX preview, OkHttp `BackendClient` (reconnect, buffered windows), GPS/IMU, alarm, `VoicePlayer` (plays the backend's ElevenLabs audio, listens for replies), Compose UI (dashcam, debug, settings, report card).

## Build and test

Needs JDK 17–21 (not 25), a `PRESAGE_API_KEY` line in `local.properties` (see `local.properties.example`) and an Android SDK (`local.properties` with `sdk.dir=...`).

    ./gradlew :core:test          # JVM unit tests
    ./gradlew :app:assembleDebug  # app/build/outputs/apk/debug/app-debug.apk

## Run against the backend

    cd ../backend && npm run dev     # NO_SPECTRUM=1 to skip iMessage/Telegram

Set the host in the app's Settings: `10.0.2.2:8787` (default) for the emulator, the laptop's LAN or Tailscale IP for a phone, or `127.0.0.1:8787` after `adb reverse tcp:8787 tcp:8787`.
Demo mode is on by default: scripted driver signals at a fake 65 mph. `DemoClock` sends windows faster (12× until the
first alert, then 1.5×) but stamps them in real time, so the engine's window-counted rules speed up while its cooldowns
stay real. With the engine's rules that gives a tier-2 warning at about 0:15 (answerable: say "I'm fine") and a
microsleep tier 3 (urgent voice, alarm, contacts) at about 1:08. `./gradlew :core:test` writes
`core/build/demo-windows.json`; `npx tsx src/dev/replayDemo.ts` in `../backend` replays it through the real engine.
Turn demo mode off to use the real camera (Presage), GPS and IMU.

Allow the microphone on first launch so spoken check-ins can hear "I'm fine" and roast replies. Logs: `adb logcat -s Presage Voice`.

Drive tab (follows the Figma "UI" design: light theme, white rounded tiles, icon tab bar): status pill, current speed
vs the fixed demo limit, a rounded card with the driver camera (the design shows a map there) and the trip button
(Start trip is a tap; ending needs a 1.5 s hold on "Hold to end trip" and works at any speed), and four tiles: attention (risk tier), drowsiness (sub-score + yawn count), eye tracking (live eye closure),
speech (Presage talking / mic listening). Tiles use the design's three states: green value, blue value, red tile.
The design's second tile is "Distraction"; the app shows drowsiness there because gaze is not measured, and that
tile has no icon in the design yet. Icons in `app/src/main/res/drawable/` are exported from the Figma file. Ending a trip shows a summary popup (average speed, top speed, alertness). Stats lists past trips (kept on the phone) and opens the latest trip's report card; Contacts is a placeholder (contacts live in the
backend's `contacts.json`); Settings links to the Debug screen.

Yawns: Presage has no yawn metric, so `FaceSampler` (core) runs every face-landmark frame through `YawnDetector`.
To tune `FaceGeometry.MAR_YAWN` (0.6), turn demo mode off, start a trip and watch `adb logcat -s Presage`: one
`face: … mouthMax=…` line per second; note the value while talking vs yawning and set the threshold between them.

## Not done yet

- Presage on a real face is unverified on a device. Eye closure and yawns come from the SDK's face landmarks (`core/FaceGeometry.kt`, assumes the MediaPipe 478-point layout); nod and gaze stay unset.
- `alarm.wav` is a generated placeholder tone.
- Weather and instrumented/UI tests.
- Voice playback and replies are built but not yet verified on a device.
