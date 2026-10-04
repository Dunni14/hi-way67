// The Tiger `settings` seed and weights.json (what the engine reads) must carry the same GPS numbers, and
// the schema must give the app its GPS tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { riskConfig } from "../risk/config.ts";
import { openFakeDb } from "../dev/fakeDb.ts";

test("settings table seeds every GPS threshold with the value the engine uses", async () => {
  const fake = await openFakeDb({ seed: false });
  try {
    const { rows } = await fake.db.query(`SELECT key, value FROM settings WHERE key LIKE 'gps\\_%'`);
    const seeded = Object.fromEntries(rows.map((r: { key: string; value: unknown }) => [r.key, r.value]));
    const g = riskConfig.gps;
    assert.deepEqual(seeded, {
      gps_speeding_over_full: g.speedingOverFull,
      gps_accuracy_max_m: g.accuracyMaxM,
      gps_min_good_fixes: g.minGoodFixes,
      gps_heading_min_speed_mps: g.headingMinSpeedMps,
      gps_erratic_accel_low: g.erratic.accelLow,
      gps_erratic_accel_full: g.erratic.accelFull,
      gps_erratic_heading_low: g.erratic.headingLow,
      gps_erratic_heading_full: g.erratic.headingFull,
      gps_fallback_limits_mph: g.fallbackLimitsMph,
      gps_trip_start_speed_mps: g.trip.startSpeedMps,
      gps_trip_start_hold_seconds: g.trip.startHoldS,
      gps_trip_stop_speed_mps: g.trip.stopSpeedMps,
      gps_trip_stop_hold_seconds: g.trip.stopHoldS,
      gps_stale_fix_seconds: g.staleFixS,
    });
    // the 10 s GPS rollup exists (as a plain view on the fake database)
    await fake.db.query(`SELECT bucket, speed_avg_mps, speed_max_mps, accel_max_mps2, heading_rate_dps, lat, lon, fixes FROM gps_10s LIMIT 1`);
  } finally {
    await fake.db.close();
  }
});
