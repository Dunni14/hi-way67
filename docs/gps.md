# GPS

The phone's GPS feeds two existing risk inputs (`speeding`, `erratic`) and adds location context to the Photon agent, the voice agent and the report card. The risk equation and the decision tree thresholds are unchanged: GPS only produces levels and context.

Code: `backend/src/gps/` (pure features, lifecycle, lookups, card section), wired in `risk/service.ts` (scoring path) and `orchestrator.ts` (Photon and voice). Tests: `backend/src/gps/*.test.ts`, run by `npm test`.

## What GPS is used for

| Use | Feeds | Where |
|---|---|---|
| Speed against the posted limit | `speeding` level | `gps/features.ts`, `gps/speedLimit.ts` |
| Hard acceleration and heading change | `erratic` level | `gps/features.ts` |
| Trip start and stop detection | trip lifecycle | `gps/lifecycle.ts`, `risk/service.ts` |
| Location in the tier 3 guardian alert | Photon agent | `agent/alertText.ts`, `trip/state.ts` |
| "Where is Alex?" answers (and where the trip ended) | Photon agent | `agent/answer.ts` |
| Next rest area or fuel station | voice lines | `gps/restStop.ts`, `voice/lines.ts` |
| Speeding nudge that names the limit | voice lines | `voice/lines.ts` |
| Route, alert markers, time over the limit | report card | `gps/route.ts`, `risk/card.ts` |

## Payload

One field added to the existing 10 second signal window (`POST /trips/{id}/windows`). There is no second upload path.

```json
"gps": {
  "fixes": [
    { "t": "2026-10-04T05:26:01Z", "lat": 42.2808, "lon": -83.7430,
      "speed_mps": 13.4, "heading_deg": 271.0, "h_accuracy_m": 6.0 }
  ]
}
```

- Up to 10 fixes per payload (more is a 400). Field names are final.
- `gps` **absent**: a legacy payload. `speed_mph` and `speed_limit_mph` are used as sent with the old mph-over formula.
- `gps: null` (permission denied, no fix): GPS is authoritative and there is none, so `speeding` is 0. The window still scores normally.
- `gps` present: `speeding` comes from GPS only. The window's `speed_mph` is replaced by the GPS speed when there are enough good fixes, and `speed_limit_mph` by the looked-up limit.

The phone's side of the contract: sample at 1 Hz, drop fixes with horizontal accuracy worse than 30 m or a negative speed (the backend drops them too), buffer them into the 10 s payload, keep working when GPS is unavailable, and show the privacy statements below on its permission screen.

## Window features

Computed per payload from the **good** fixes (accuracy 30 m or better, speed present and not negative, parseable time).

| Feature | Definition |
|---|---|
| `speed_mps` | Median fix speed |
| `speed_max_mps` | Max fix speed |
| `accel_max_mps2` | Max absolute speed change per second between consecutive fixes |
| `heading_rate_dps` | Max absolute heading change per second, wrapped to 180 (359 to 1 is 2 degrees) |
| last fix | Last good fix: lat, lon, heading |
| `gps_ok` | At least 3 good fixes |

Heading is ignored when either fix is under 3 m/s. A negative heading (the platforms' "no heading") counts as none.

## Levels

```
speeding = clamp(((speed - limit) / limit) / 0.30, 0, 1)        0 at the limit, 0.5 at 15% over, 1 at 30% over
erratic  = max(a, h)
  a = clamp((accel_max - 2.5) / (5.0 - 2.5), 0, 1)
  h = clamp((heading_rate - 20) / (45 - 20), 0, 1)
```

- `speeding` is 0 when `gps_ok` is false or the limit is unknown (`limit_source = none`). It never guesses.
- The window's `erratic` is `max(erratic_motion, erratic_gps)`, where `erratic_motion` is the phone's hard-brake and swerve count.
- Neither is scored while **stopped** (good GPS and median speed under 1 m/s), including the phone's own motion events.
- Both levels go through the engine's normal 3-window smoothing, like every other numeric input.

All thresholds are hand-set. None come from the Dingus paper.

| Setting | Value | `settings` key (Tiger) | `weights.json` |
|---|---|---|---|
| Over-limit fraction that is full speeding | 0.30 | `gps_speeding_over_full` | `gps.speedingOverFull` |
| Accuracy cutoff | 30 m | `gps_accuracy_max_m` | `gps.accuracyMaxM` |
| Good fixes needed | 3 | `gps_min_good_fixes` | `gps.minGoodFixes` |
| Heading ignored under | 3 m/s | `gps_heading_min_speed_mps` | `gps.headingMinSpeedMps` |
| Erratic accel ramp | 2.5 to 5.0 m/s² | `gps_erratic_accel_low` / `_full` | `gps.erratic.accel*` |
| Erratic heading ramp | 20 to 45 deg/s | `gps_erratic_heading_low` / `_full` | `gps.erratic.heading*` |
| Fallback limits by highway class | see below | `gps_fallback_limits_mph` | `gps.fallbackLimitsMph` |
| Trip start | above 4 m/s for 20 s | `gps_trip_start_speed_mps` / `_hold_seconds` | `gps.trip.start*` |
| Trip stop (also "stopped") | under 1 m/s for 300 s | `gps_trip_stop_speed_mps` / `_hold_seconds` | `gps.trip.stop*` |
| Stale fix | 60 s | `gps_stale_fix_seconds` | `gps.staleFixS` |

The engine reads `weights.json`, same as every other weight; `backend/sql/02_seed.sql` seeds the same numbers into the Tiger `settings` table, and `gps/seed.test.ts` fails if the two disagree. Change both together. Lookup timeouts, cache sizes and the rest stop cone are in `weights.json` only (`gps.lookup`, `gps.restStop`).

## Posted speed limit

`SpeedLimitProvider` (`gps/speedLimit.ts`):

1. Query OpenStreetMap through Overpass for driveable ways within 25 m of the last good fix. The way whose bearing best matches the heading wins (nearest when the heading is unknown or under 3 m/s; direction of travel does not matter, a road is the same road both ways). Distance breaks ties between parallel ways.
2. Use that way's `maxspeed`: `45 mph`, or a bare number which OSM defines as km/h. `none`, `signals` and lists are not usable. `limit_source = osm`.
3. No usable `maxspeed`: fall back by `highway` class (`_link` roads use their parent class). `limit_source = fallback`. No class in the table (service roads, living streets): `limit_source = none`.

| Highway class | Fallback limit |
|---|---|
| motorway | 70 mph |
| trunk, primary | 55 mph |
| secondary, tertiary | 45 mph |
| residential, unclassified | 25 mph |

**It never blocks scoring.** `lookup` answers synchronously from the cache (key: lat/lon rounded to 4 decimals, about 11 m, 24 h TTL, 5000 entries) or from the last known limit of the trip, and starts the network fetch in the background. The answer is used from the next lookup on, so **the limit lags the car by up to one window** (a window is about 300 m at highway speed). A timeout, error or outage costs a stale limit and then a 30 s backoff, never a late score. At most 2 lookups are in flight.

**Endpoints.** `OVERPASS_URLS` (comma list, tried in order, 6 s timeout each). Default: `overpass-api.de` then `overpass.openstreetmap.fr` (a different operator). A failed endpoint is skipped for 60 s, so a dead primary costs one timeout, not one per lookup. Public instances are rate limited and come and go (`overpass.private.coffee` and `overpass.kumi.systems` did not answer when this was written): re-test your backup before a demo.

Fallback values are hand-set and are flagged in the report card whenever used.

## Trip lifecycle

`advanceMotion` (`gps/lifecycle.ts`) runs on the good fixes, using the fix times as the clock.

- **Started**: speed above 4 m/s continuously for 20 s. Until then the trip is `idle`; `gps.moving` is false.
- **Ended**: once started, speed under 1 m/s continuously for 5 minutes. The service then ends the trip by itself (writes the report card). The window's `gps.trip_ended` is true and later windows get 409.
- A trip that never started moving is not ended by this rule.

`POST /trips` still creates the trip and `POST /trips/{id}/end` still ends it; detection adds to them. The orchestrator turns `started` and `ended` into its trip start and arrival messages. The motion state is rebuilt from the stored fixes after a restart.

## Storage

`backend/sql/01_schema.sql` (and the idempotent mirror in `risk/store/schema.ts`; `schema.drift.test.ts` keeps them equal). Names follow the existing tables: ids are `text`, not `UUID`.

- `gps_samples`: `time, trip_id, driver_id, lat, lon, speed_mps, heading_deg, h_accuracy_m, limit_mps, limit_source`, plus `accel_mps2` and `heading_rate_dps` per fix. Hypertable on `time`, index `(trip_id, time DESC)`. Only good fixes, only for an active trip (windows for an ended trip are refused).
- `windows` gains `gps_speeding`, `gps_erratic`, `gps_stopped`, `limit_source`, which is what the engine replays after a restart. Raw fixes stay in `gps_samples`.
- `drivers.share_location` (default true).
- `gps_10s` continuous aggregate (10 s, refreshed every 10 s): `speed_avg_mps, speed_max_mps, accel_max_mps2, heading_rate_dps, lat, lon, fixes`. A continuous aggregate cannot take a median or a difference between rows, so this is a rollup, not the scoring input: speed is a **mean** here (the app scores on the median) and accel and heading rate are the max of the per-fix columns the app writes. `gps_ok` is `fixes >= 3`.
- Retention: raw fixes 7 days. The aggregate has none, same as `windows_30s` and `trip_summary_5m`.
- `settings` rows for every threshold (`02_seed.sql`).

Existing Tiger services need `01_schema.sql` and `02_seed.sql` re-run (both are idempotent, and the new `ALTER TABLE ... IF NOT EXISTS` lines upgrade the existing tables). The app's own `migrate()` adds the same tables and columns on boot, minus the TimescaleDB parts.

## Photon iMessage agent

- **Tier 3 alert** (`guardianAlertText`): the existing alert plus a line `📍 near Main St, Ann Arbor · 58 mph · fix at 5:26 AM` and `https://maps.apple.com/?ll=42.2808,-83.7430`. Road and city come from reverse geocoding (Nominatim, `GEOCODER_URL` to override, 2.5 s timeout). If geocoding fails the line has no `near …` part but keeps the link, speed and time. With no fix, the alert is unchanged.
- **Stale fix**: older than 60 s, the line says `last fix 3 minutes ago (5:26 AM)`.
- **"Where is Alex?"**: guardians get the same line while the trip is active, under the existing sharing rules. After the trip ends they get `Trip ended at 5:41 AM near … <link>` (sharing `always`, or `high_only` after a recent high alert). Friends never get a position.
- Guardian alerts still go through `post(text, "guardian")`.

## Voice agent

- **Speeding nudge**: tier 1 reckless alerts where speeding is the largest reckless level and the limit is known play `Limit here is 45. You are at 58.` instead of the generic reminder.
- **Rest stop**: drowsy tiers 2 and 3 get the next rest area (`highway=rest_area`) or fuel station (`amenity=fuel`) within 15 km, in a 60 degree cone around the heading, appended to the existing line: `The next stop is 4 miles ahead.` (tier 2) or `Pull over at the next stop, 4 miles ahead.` (tier 3). It is a parameter of the existing rest recommendation, not a bandit action. Lookups are cached (about 1 km cells, 5 min) and warmed at drowsy tier 1; the alert waits at most 1.5 s for it and plays without it otherwise.

## Report card

`card.gps` (null when the trip had no GPS):

- `route`: one point per 10 s (`t, lat, lon`).
- `alerts`: a marker (`t, tier, lat, lon`) for every fired alert event of tier 1 to 3, at the fix nearest in time (within 30 s).
- `pct_over_limit`: share of the trip's fixes with speed over a known limit. `pct_fallback_limit`: share whose limit came from the fallback table. Both use every fix of the trip as the denominator, stopped time included.
- `fallback_used` and `limit_note`: set whenever the fallback table supplied any limit.

It lives in the stored card, so it outlives the 7 day retention on raw fixes. It is not part of the `features` vector or the card score.

## Privacy

- Location is only stored during an active trip, and the stored raw fixes expire after 7 days.
- Family sees location only through the agent, never a coordinate history: the agent only ever has the last fix.
- One setting turns location sharing off: `share_location` on `POST /trips` (omitted keeps the driver's stored choice, default on), or `shareLocation` in the WebSocket `hello` / `settings` frames. With it off, scoring still uses GPS and the voice agent still uses the fix, but nothing with a position reaches Photon: no link in alerts, no location in answers, no geocoding. The gate is `trip.shareLocation` in `trip/state.ts`; every Photon-bound path goes through its methods.
- The phone's permission screen should state all of this.

## Testing

`npm test` covers: `gps: null`, accuracy filtering, the speeding ramp (0, 0.5, 1), heading wrap, heading ignored under 3 m/s, fallback limits and `limit_source`, Overpass timeouts and backup, the tier 3 link, and a replay of a GPX drive through the real service on in-process Postgres (`gps/fixtures/drive.gpx`).

The GPX is **synthetic** (`npx tsx src/dev/makeDrive.ts` regenerates it): parked, pull away, cruise 27 mph, cruise 38 mph on a 25 mph road, a 180 degree turn in 3 s, coast to a stop, parked 5 minutes. Replace it with a real recording to measure the fallback rate (open item 3).

## Open items

1. All thresholds are hand-set. None come from the Dingus paper.
2. The SHRP 2 speeding odds ratio (12.8) is for speed relative to conditions as judged by video reviewers, not GPS speed over the posted limit. Mapping our `speeding` level to that weight is an assumption.
3. OSM `maxspeed` coverage is patchy on smaller roads. Measure the fallback rate on a test drive (`card.gps.pct_fallback_limit`).
4. Public Overpass servers are rate limited and some are dead. Caching and a skip-failed-endpoint rule are in place; the default backup answered in a manual test on 2026-10-04, but re-verify before the demo.
5. The limit lags the car by up to one window (see above).
6. `gps_10s` uses mean speed, not median (continuous aggregate limitation).
7. The new DDL has been tested on plain Postgres (PGlite) only, not on a TimescaleDB service. Run `01_schema.sql` and `02_seed.sql` on Tiger and check that `gps_10s` and the retention policy are created.
