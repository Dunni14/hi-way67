// What contacts and the driver hear: tier 3 alert text, "where is he?" facts, voice lines, privacy gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardianAlertText } from "../agent/alertText.ts";
import { tripFacts } from "../agent/answer.ts";
import { riskConfig } from "../risk/config.ts";
import type { Evaluation } from "../risk/types.ts";
import { trip } from "../trip/state.ts";
import { alertLine, milesPhrase, speedingLine, speedingNudge } from "../voice/lines.ts";
import { locationLine, mapsLink } from "./message.ts";
import { mphToMps, type LocationFix } from "./types.ts";

const NOW = Date.parse("2026-10-04T05:30:00Z");
const fixAt = (ageS: number, o: Partial<LocationFix> = {}): LocationFix => ({ ms: NOW - ageS * 1000, lat: 42.28082, lon: -83.74297, speed_mps: mphToMps(58), heading_deg: 271, ...o });

function freshTrip(fix: LocationFix | null, o: { share?: boolean; sharing?: "always" | "high_only" | "never" } = {}) {
  trip.start(NOW - 20 * 60_000);
  trip.shareLocation = o.share ?? true;
  trip.sharingMode = o.sharing ?? "always";
  if (fix) trip.setFix(fix);
  return trip;
}

test("tier 3 alert carries an Apple Maps link, speed and fix time when a fix exists", () => {
  const t = freshTrip(fixAt(5));
  t.lastFix!.place = "State St, Ann Arbor";
  const text = guardianAlertText("Alex", "drowsy", t.locationText(NOW));
  assert.ok(text.includes("https://maps.apple.com/?ll=42.2808,-83.7430"), text);
  assert.match(text, /near State St, Ann Arbor/);
  assert.match(text, /58 mph/);
  assert.match(text, /fix at \d{1,2}:\d{2}/);
  assert.doesNotMatch(text, /last fix/);
});

test("tier 3 alert omits location cleanly with no fix, and sends the link alone when geocoding failed", () => {
  const none = guardianAlertText("Alex", "reckless", freshTrip(null).locationText(NOW));
  assert.equal(none, "⚠️ Alex is at high risk (reckless). I've told them to pull over.");
  const t = freshTrip(fixAt(5));
  t.lastFix!.place = null; // geocoder failed
  const text = guardianAlertText("Alex", "drowsy", t.locationText(NOW));
  assert.ok(text.includes("maps.apple.com"));
  assert.doesNotMatch(text, /near/);
});

test("a fix older than 60 seconds is labelled with its age", () => {
  const line = locationLine(fixAt(185), null, NOW, riskConfig.gps.staleFixS)!;
  assert.match(line, /last fix 3 minutes ago/);
  assert.match(locationLine(fixAt(75), null, NOW, 60)!, /last fix 75 seconds ago/);
  assert.doesNotMatch(locationLine(fixAt(59), null, NOW, 60)!, /last fix/);
  assert.equal(locationLine(null, null, NOW, 60), null);
  assert.match(locationLine(fixAt(1, { speed_mps: 0.2 }), null, NOW, 60)!, /stopped/);
});

test("location sharing off: nothing with lat/lon reaches the agent", () => {
  const t = freshTrip(fixAt(5), { share: false });
  assert.equal(t.mapsLink(), null);
  assert.equal(t.locationText(NOW), null);
  assert.equal(t.endLocationText(), null);
  const text = guardianAlertText("Alex", "drowsy", t.locationText(NOW));
  assert.doesNotMatch(text, /maps\.apple|42\.28|83\.74/);
  assert.ok(!tripFacts("guardian", NOW).join(" ").match(/maps\.apple|42\.28/));
});

test("family questions: guardians get the position while the trip is active, friends never do", () => {
  freshTrip(fixAt(5));
  const guardian = tripFacts("guardian", NOW).join("\n");
  assert.match(guardian, /Location: .*https:\/\/maps\.apple\.com\/\?ll=42\.2808,-83\.7430/);
  assert.doesNotMatch(tripFacts("friend", NOW).join("\n"), /maps\.apple|Location/);
});

test("after the trip ends the guardians get the end location and time, and only the guardians", () => {
  freshTrip(fixAt(5));
  trip.end(NOW);
  const facts = tripFacts("guardian", NOW + 60_000);
  assert.match(facts.join("\n"), /not on a drive/);
  assert.match(facts.join("\n"), /Trip ended at .*https:\/\/maps\.apple\.com/);
  assert.doesNotMatch(tripFacts("friend", NOW + 60_000).join("\n"), /maps\.apple/);
  trip.sharingMode = "never";
  assert.doesNotMatch(tripFacts("guardian", NOW + 60_000).join("\n"), /maps\.apple/);
  trip.sharingMode = "high_only"; // shares details only after a recent high alert
  assert.doesNotMatch(tripFacts("guardian", NOW + 60_000).join("\n"), /maps\.apple/);
});

test("maps link format", () => {
  assert.equal(mapsLink({ lat: 42.2808, lon: -83.743 }), "https://maps.apple.com/?ll=42.2808,-83.7430");
});

const ev = (o: Partial<Omit<Evaluation, "gps" | "levels">> & { gps?: Partial<NonNullable<Evaluation["gps"]>>; levels?: Partial<Evaluation["levels"]> }): Evaluation => {
  const { gps, levels, ...rest } = o;
  return {
    score: 50, tier: 1, dominant: "reckless", actions: ["voice_nudge"], override: null, degraded: false,
    ...rest,
    levels: { drowsy: 0, agitated: 0, speeding: 0.6, phone: 0, distracted: 0, erratic: 0, ...levels },
    gps: { ok: true, speed_mps: mphToMps(58), limit_mph: 45, limit_source: "osm", stopped: false, moving: true, ...gps },
  };
};

test("speeding nudge names the limit and the speed", () => {
  assert.equal(speedingLine(45, 58), "Limit here is 45. You are at 58.");
  assert.equal(speedingNudge(ev({})), "Limit here is 45. You are at 58.");
});

test("speeding nudge only when speeding is what is driving a tier 1 reckless alert and the limit is known", () => {
  assert.equal(speedingNudge(ev({ levels: { agitated: 0.9 } })), null);
  assert.equal(speedingNudge(ev({ levels: { speeding: 0 } })), null);
  assert.equal(speedingNudge(ev({ gps: { limit_mph: null, limit_source: "none" } })), null);
  assert.equal(speedingNudge(ev({ gps: { stopped: true } })), null);
  assert.equal(speedingNudge(ev({ tier: 2 })), null);
  assert.equal(speedingNudge(ev({ dominant: "drowsy" })), null);
  assert.equal(speedingNudge({ ...ev({}), gps: undefined }), null);
});

test("drowsy tiers 2 and 3 name the next stop as a parameter of the existing line", () => {
  assert.match(alertLine(70, "drowsy", { restMiles: 4 }), /The next stop is 4 miles ahead\.$/);
  assert.match(alertLine(85, "drowsy", { restMiles: 4 }), /Pull over at the next stop, 4 miles ahead\.$/);
  // unchanged without a stop, for tier 1, and for reckless
  assert.doesNotMatch(alertLine(70, "drowsy", { restMiles: null }), /next stop/);
  assert.doesNotMatch(alertLine(40, "drowsy", { restMiles: 4 }), /miles ahead/);
  assert.doesNotMatch(alertLine(85, "reckless", { restMiles: 4 }), /miles ahead/);
  assert.equal(milesPhrase(0.4), "less than a mile");
  assert.equal(milesPhrase(1), "1 mile");
  assert.equal(milesPhrase(3.26), "3.3 miles");
  assert.equal(milesPhrase(12.4), "12 miles");
});
