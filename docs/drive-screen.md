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

## Mapbox

`com.mapbox.maps:android-ndk27:11.32.0`, from the install guide as of July 2026: no secret download token is needed any more, and the `-ndk27` build is the one with 16 KB page size support, which targetSdk 36 needs. The repository is added in `settings.gradle.kts` with a `content` filter for `com.mapbox*` and listed before the Presage repo, so resolving Mapbox never depends on the Presage host.

Map (`DriveMap.kt`): Standard style with the `basemap` import configured (`STANDARD_CONFIG`: day, monochrome theme, POI/transit/place labels off, road labels and 3D objects on), pitch 60, zoom 17.5, follow-puck camera with bottom padding of a third of the map height, course-bearing 2D puck (`drive_puck.xml`), gestures off, compass and scale bar hidden, logo and attribution left on. Under 3 m/s the camera holds the last bearing. The route line (casing 12 and fill 8, round caps, `middle` slot) is drawn only when `setRoute` gets GeoJSON; nothing is faked.

## Screen

Zones: header (speed, status pill, limit), map box (takes the leftover height, minimum 200 dp), 2 x 2 status grid, bottom nav. Tokens are in `res/values/drive_tokens.xml`. If six boxes would push the map under its minimum, the grid scrolls (`MaxHeightScrollView`).

Slots, the XML way: boxes are a `List<StatusBox>` in `DriveUiState` (`onClick == null` is static with no ripple, `content` replaces the body inside the same frame), anything can be drawn over the map in the `mapOverlay` frame (the tier banner is in there), and header and nav are plain views.

State: `DriveViewModel` exposes one `DriveUiState`. Header speed is from 1 Hz platform GPS fixes (`DriveLocationSource`, same filter as the backend: accuracy 30 m, no negative speed). Limit, tier and box levels come from `WindowResult` (the parsed `POST /trips/{id}/windows` response, see [risk-engine.md](risk-engine.md)). The limit source is the backend's Overpass lookup, so Mapbox Map Matching is not used. The map never sees speed.

Box levels: `distracted` to Attention, `phone` to Distraction, `drowsy` (or a microsleep) to Eye Tracking, a given level to Speech. Cutoffs 0.25 / 0.5 / 0.75 are hand-set, seeded as `drive_box_level_cutoffs` in the Tiger `settings` table and defaulted in `LevelCutoffs`.

## Not done

- **Nothing sends windows or reads the response yet.** The app has no networking: `onWindowResult` is the entry point, but no code posts the 10 s payload to the backend. Until it does, only the speed comes from real data; the limit, tier and box levels stay at their defaults (or fake with `--ez demo true`).
- **Speech box** is a fixed neutral level: the ElevenLabs agent state is not exposed to the phone.
- **Route line** has no Directions call or destination picker.
- **The 3D look is unchecked.** Theme (`monochrome` vs `faded`), colours and sizes are read off the mockup. Mapbox needs native GL, so the map, puck, camera and gesture settings were compiled but not run. Test on a device with a token.
- The location prompt is in `DriveActivity`; there was no existing phone GPS flow to reuse.

## Tests

`./gradlew :app:testDebugUnitTest`: `DriveLogicTest` (levels, speed colour, limit text and dot, trip state, bearing hold, fix filter, grid cap, response parsing) and `DriveScreenTest` (Robolectric: permission denied shows "No GPS", no token shows a map-box error, static versus clickable boxes, GOOD to BAD goes red, `--` limit, tier banner, gestures default off, 360 dp header). The map itself is not covered.
