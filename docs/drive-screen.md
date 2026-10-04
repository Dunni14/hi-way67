# Drive screen (Android)

A 3D Mapbox map, speed readouts, four status boxes and a bottom nav, in `android/app/src/main/java/com/example/coolvitals/drive/`. It does not change scoring.

The app is XML views on the Presage SmartSpectra SDK, so this is built with views, not Compose (the spec's fallback). `MainActivity` (Presage) is untouched; `DriveActivity` is a second launcher entry.

## Run it

```sh
cd android
cp mapbox_access_token.xml.example app/src/main/res/values/mapbox_access_token.xml   # gitignored; put your pk. token in it
export JAVA_HOME=<JDK 17 or 21>          # not 25: Gradle 8.14 cannot run on it
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
adb shell am start -n com.example.coolvitals/.drive.DriveActivity --ez demo true    # fake data
```

`local.properties` needs `sdk.dir` (see `local.properties.example`). Without a token the map box shows a message instead of crashing.

## Setup outside the editor

1. **Mapbox**: free account, create a public token (`pk.`), optionally restrict it to the app id `com.example.coolvitals`. Put it in `android/app/src/main/res/values/mapbox_access_token.xml` (copy the `.example`, gitignored). No secret `sk.` token is needed for 11.32.0.
2. **A real Android phone**: Developer options, USB debugging, plug in and accept the prompt. The 3D map wants real GL and GPS; emulators are weak at both.
3. **Toolchain on your machine**: Android Studio (or the command-line SDK with platform 36 and build-tools 36), JDK 17 or 21 (not 25), and `android/local.properties` with `sdk.dir`, `PRESAGE_API_KEY`, `BACKEND_URL`, `DRIVER_ID`.
4. **Backend reachable from the phone**: `npm run dev:fake` (or with Tiger) on the laptop, phone and laptop on the same Wi-Fi, the laptop's LAN IP in `BACKEND_URL`, port 8787 open in the firewall. On venue Wi-Fi with client isolation use a phone hotspot or an https tunnel (cloudflared, ngrok).
5. **Tiger**, only if you want data kept there: re-run `backend/sql/01_schema.sql` and `02_seed.sql` (new GPS tables and settings). `FAKE_DB=1` needs nothing.
6. **Tune the look on the device**: monochrome vs faded theme, colours against the Figma file, and whether 3D buildings and trees show where you will demo.
7. **Test without driving**: play `backend/src/gps/fixtures/drive.gpx` as mock locations (emulator Extended controls > Location, or pick a mock-location app under Developer options).
8. Mapbox free-tier limits are fine for a demo; Directions calls (route line, later) count separately.

## Mapbox

`com.mapbox.maps:android-ndk27:11.32.0`, from the install guide as of July 2026: no secret download token is needed any more, and the `-ndk27` build is the one with 16 KB page size support, which targetSdk 36 needs. The repository is added in `settings.gradle.kts` with a `content` filter for `com.mapbox*` and listed before the Presage repo, so resolving Mapbox never depends on the Presage host.

Map (`DriveMap.kt`): Standard style with the `basemap` import configured (`STANDARD_CONFIG`: day, monochrome theme, POI/transit/place labels off, road labels and 3D objects on), pitch 60, zoom 17.5, follow-puck camera with bottom padding of a third of the map height, course-bearing 2D puck (`drive_puck.xml`), gestures off, compass and scale bar hidden, logo and attribution left on. Under 3 m/s the camera holds the last bearing. The route line (casing 12 and fill 8, round caps, `middle` slot) is drawn only when `setRoute` gets GeoJSON; nothing is faked.

## Screen

Zones: header (speed, status pill, limit), map box (takes the leftover height, minimum 200 dp), 2 x 2 status grid, bottom nav. Tokens are in `res/values/drive_tokens.xml`. If six boxes would push the map under its minimum, the grid scrolls (`MaxHeightScrollView`).

Slots, the XML way: boxes are a `List<StatusBox>` in `DriveUiState` (`onClick == null` is static with no ripple, `content` replaces the body inside the same frame), anything can be drawn over the map in the `mapOverlay` frame (the tier banner is in there), and header and nav are plain views.

State: `DriveViewModel` exposes one `DriveUiState`. Header speed is from 1 Hz platform GPS fixes (`DriveLocationSource`, same filter as the backend: accuracy 30 m, no negative speed). Limit, tier and box levels come from `WindowResult` (the parsed `POST /trips/{id}/windows` response, see [risk-engine.md](risk-engine.md)). The limit source is the backend's Overpass lookup, so Mapbox Map Matching is not used. The map never sees speed.

Box levels: `distracted` to Attention, `phone` to Distraction, `drowsy` (or a microsleep) to Eye Tracking, a given level to Speech. Cutoffs 0.25 / 0.5 / 0.75 are hand-set, seeded as `drive_box_level_cutoffs` in the Tiger `settings` table and defaulted in `LevelCutoffs`.

## Backend link

The Drive screen talks to the backend over REST ([risk-engine.md](risk-engine.md), [gps.md](gps.md)), not the legacy WebSocket. Code: `net/Backend.kt` (`HttpBackend`, plain `HttpURLConnection`, 5 s timeouts), `drive/DriveSession.kt`, `drive/WindowPayload.kt`.

1. Location permission granted: the `DriveViewModel` starts a `DriveSession` (once; rotation does not start another).
2. Every 10 s: the first tick does `POST /trips {driver_id, share_location}`, then each tick does `POST /trips/{id}/windows` with `ts` (the last fix's own time) and `gps: {fixes}` (the newest 10 good fixes), or `gps: null` when there is no good fix. The response goes to `DriveViewModel.onWindowResult`: limit, tier, box levels.
3. The backend ends the trip itself after 5 minutes stopped (`gps.trip_ended`, or a 409): the session goes idle and starts a new trip on the next fix above 4 m/s.
4. Background (`onStop`): posting pauses, since location is off. Finishing the activity ends the trip (`POST /trips/{id}/end`, best effort).
5. A failing backend never blocks or crashes the screen: the pill shows "Offline" and posting resumes by itself.

Config, in the gitignored `android/local.properties` (see `local.properties.example`): `BACKEND_URL` (default `http://10.0.2.2:8787`, the emulator's name for the host; on a phone use the laptop's LAN IP or an https tunnel), `DRIVER_ID` (default `demo`), `SHARE_LOCATION` (default `true`, the driver's choice whether contacts can see location). Plain http is allowed in debug builds only (`src/debug/res/xml/network_security_config.xml`); a release build needs https.

Check it against a real backend (the test skips itself without `BACKEND_URL`):

```sh
cd backend && PORT=8799 FAKE_DB=1 NO_SPECTRUM=1 npx tsx src/index.ts
cd android && BACKEND_URL=http://127.0.0.1:8799 ./gradlew :app:testDebugUnitTest --tests '*BackendIntegrationTest'
```

It replays the synthetic `drive.gpx` through the real session and client: trip created, 50+ windows scored, the backend ends the trip after the long stop, nothing is posted afterwards.

## Not done

- **Presage is not in the windows.** The Drive screen does not own the camera (Presage runs in `MainActivity`), so windows carry GPS only and the face boxes read as "no evidence" (Attention, Distraction and Eye Tracking stay GREAT). `SignalSource` in `WindowPayload.kt` is the seam: give `DriveViewModel.startSession` a source that returns the backend's `SignalWindow` field names and they go into each window.
- **No retry queue.** A window that fails to post is lost; the next one goes out normally.
- **Speech box** is a fixed neutral level: the ElevenLabs agent state is not exposed to the phone.
- **Route line** has no Directions call or destination picker.
- **The 3D look is unchecked.** Theme (`monochrome` vs `faded`), colours and sizes are read off the mockup. Mapbox needs native GL, so the map, puck, camera and gesture settings were compiled but not run. Test on a device with a token.
- The location prompt is in `DriveActivity`; there was no existing phone GPS flow to reuse.

## Tests

`./gradlew :app:testDebugUnitTest`: `NetworkingTest` (payload, fix buffer, HTTP client against a local server, session: offline, retry, trip end and restart, pause), `DriveLogicTest` (levels, speed colour, limit text and dot, trip state, bearing hold, fix filter, grid cap, response parsing) and `DriveScreenTest` (Robolectric: permission denied shows "No GPS", no token shows a map-box error, static versus clickable boxes, GOOD to BAD goes red, `--` limit, tier banner, gestures default off, 360 dp header). The map itself is not covered.
