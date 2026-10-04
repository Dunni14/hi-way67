// GPS through the real RiskService on in-process Postgres: payload handling, scoring, stored fixes, trip
// start/stop, restart replay, privacy setting, and a recorded-style GPX drive end to end.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { createRiskRoutes } from "../http/risk.ts";
import { riskConfig } from "../risk/config.ts";
import { HttpError, RiskService, type EvaluationExtra } from "../risk/service.ts";
import { PgRiskStore } from "../risk/store/pg.ts";
import type { Evaluation, SignalWindow } from "../risk/types.ts";
import { fixesFromGpx } from "./gpx.ts";
import type { FetchLike, OsmElement } from "./overpass.ts";
import { SpeedLimitProvider } from "./speedLimit.ts";
import { mphToMps, type GpsFix } from "./types.ts";

const T0 = Date.parse("2026-10-04T05:20:00Z");
const NEUTRAL = {
  face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0,
};

let db: PGlite;
let store: PgRiskStore;
before(async () => {
  db = new PGlite();
  store = new PgRiskStore(db);
  await store.migrate();
});
after(() => db.close());

/** Overpass stand-in: an E-W way through whatever point is asked about. */
const road = (tags: Record<string, string>): FetchLike & { calls: number; down: boolean } => {
  const f = Object.assign(
    async (_u: string, init?: { body?: string; signal?: AbortSignal }) => {
      f.calls++;
      if (f.down) return new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      const [, lat, lon] = /around:\d+,([-\d.]+),([-\d.]+)/.exec(decodeURIComponent(init!.body!))!;
      const way: OsmElement = { type: "way", id: 1, tags, geometry: [{ lat: Number(lat), lon: Number(lon) - 0.001 }, { lat: Number(lat), lon: Number(lon) + 0.001 }] };
      return { ok: true, status: 200, json: async () => ({ elements: [way] }) };
    },
    { calls: 0, down: false },
  );
  return f;
};
const quickCfg = { ...riskConfig, gps: { ...riskConfig.gps, lookup: { ...riskConfig.gps.lookup, timeoutMs: 40 } } };

type Hook = { tripId: string; ev: Evaluation; extra: EvaluationExtra };
function setup(tags: Record<string, string> = { highway: "primary", maxspeed: "45 mph" }) {
  const fetch = road(tags);
  const provider = new SpeedLimitProvider(quickCfg, { fetch, endpoints: ["http://x"] });
  const hooks: Hook[] = [];
  const svc = new RiskService(store, riskConfig, (tripId, ev, extra) => void hooks.push({ tripId, ev, extra }), undefined, provider);
  return { svc, provider, fetch, hooks };
}

/** 10 fixes at 1 Hz ending at window `i`, driving east at `speed` (m/s) unless a per-fix speed list is given. */
let lonCursor = -83.74;
const fixesFor = (i: number, speed: number | number[], o: Partial<GpsFix> = {}): GpsFix[] =>
  Array.from({ length: 10 }, (_, k) => {
    const v = Array.isArray(speed) ? speed[k]! : speed;
    lonCursor += (v * 1.35e-5) / 1; // ~1 m of longitude at this latitude is 1.35e-5 deg
    return { t: new Date(T0 + i * 10_000 - (9 - k) * 1000).toISOString(), lat: 42.28, lon: lonCursor, speed_mps: v, heading_deg: 90, h_accuracy_m: 6, ...o };
  });
const win = (i: number, gps: SignalWindow["gps"] | undefined, o: Partial<SignalWindow> = {}): SignalWindow => ({
  ...NEUTRAL, ts: new Date(T0 + i * 10_000).toISOString(), ...(gps === undefined ? {} : { gps }), ...o,
});

/** Warm up past the 6 baseline windows at a steady speed, letting each limit lookup land before the next window. */
async function drive(s: ReturnType<typeof setup>, trip: string, speed: number, n: number, from = 0, o: Partial<SignalWindow> = {}) {
  let last!: Evaluation;
  for (let i = from; i < from + n; i++) {
    last = await s.svc.ingestWindow(trip, win(i, { fixes: fixesFor(i, speed) }, o));
    await s.provider.idle();
  }
  return last;
}

test("gps: null scores without error and speeding is 0; no gps field keeps the legacy mph formula", async () => {
  const { svc } = setup();
  const nul = (await svc.startTrip({ driver_id: "g-null", kids_in_car: false, low_experience: false })).trip_id;
  const legacy = (await svc.startTrip({ driver_id: "g-legacy", kids_in_car: false, low_experience: false })).trip_id;
  let a!: Evaluation;
  let b!: Evaluation;
  for (let i = 0; i < 12; i++) {
    const over = { speed_mph: 90, speed_limit_mph: 70 };
    a = await svc.ingestWindow(nul, win(i, null, over));
    b = await svc.ingestWindow(legacy, win(i, undefined, over));
  }
  assert.equal(a.levels.speeding, 0);
  assert.equal(a.gps?.ok, false);
  assert.equal(a.gps?.limit_source, "none");
  assert.ok(b.levels.speeding > 0.9, "legacy payloads are unchanged");
  assert.equal(b.gps, undefined);
});

test("over the posted limit: 0 at the limit, 1 at 30 percent over, from an OSM maxspeed", async () => {
  const limit = mphToMps(45);
  const at = setup();
  const t1 = (await at.svc.startTrip({ driver_id: "g-at", kids_in_car: false, low_experience: false })).trip_id;
  const atLimit = await drive(at, t1, limit, 12);
  assert.equal(atLimit.levels.speeding, 0);
  assert.equal(atLimit.gps?.limit_mph, 45);
  assert.equal(atLimit.gps?.limit_source, "osm");

  const over = setup();
  const t2 = (await over.svc.startTrip({ driver_id: "g-over", kids_in_car: false, low_experience: false })).trip_id;
  const e = await drive(over, t2, limit * 1.3, 14);
  assert.ok(e.levels.speeding > 0.99, `speeding ${e.levels.speeding}`);
  assert.ok(e.score > 60);
  assert.equal(e.gps?.stopped, false);
});

test("the stored window and fixes carry the limit and its source; a missing maxspeed is flagged fallback in the card", async () => {
  const s = setup({ highway: "residential" });
  const trip = (await s.svc.startTrip({ driver_id: "g-fb", kids_in_car: false, low_experience: false })).trip_id;
  const e = await drive(s, trip, mphToMps(30), 8);
  assert.equal(e.gps?.limit_source, "fallback");
  assert.equal(e.gps?.limit_mph, 25);
  assert.ok(e.levels.speeding > 0.5); // 30 over 25 mph is 20 percent over -> 0.67 before smoothing

  const rows = await store.getWindows(trip);
  assert.equal(rows.at(-1)!.raw.limit_source, "fallback");
  const samples = await store.getGpsSamples(trip);
  assert.equal(samples.length, 80);
  assert.equal(samples.at(-1)!.limitSource, "fallback");
  assert.ok(Math.abs(samples.at(-1)!.limitMps! - mphToMps(25)) < 1e-3);

  const card = (await s.svc.card(trip)).gps!;
  assert.equal(card.fallback_used, true);
  assert.ok(card.pct_fallback_limit > 80);
  assert.match(card.limit_note!, /hand-set/);
});

test("fixes over 30 m accuracy never reach gps_samples and give no good gps", async () => {
  const s = setup();
  const trip = (await s.svc.startTrip({ driver_id: "g-acc", kids_in_car: false, low_experience: false })).trip_id;
  const e = await s.svc.ingestWindow(trip, win(0, { fixes: fixesFor(0, 20, { h_accuracy_m: 45 }) }));
  assert.equal(e.gps?.ok, false);
  assert.equal((await store.getGpsSamples(trip)).length, 0);
});

test("an Overpass outage does not delay the score and the last known limit is used", async () => {
  const s = setup();
  const trip = (await s.svc.startTrip({ driver_id: "g-out", kids_in_car: false, low_experience: false })).trip_id;
  await drive(s, trip, mphToMps(40), 3);
  s.fetch.down = true;
  const started = performance.now();
  const e = await s.svc.ingestWindow(trip, win(3, { fixes: fixesFor(3, mphToMps(40)) }));
  assert.ok(performance.now() - started < 1000, "scoring must not wait for Overpass");
  assert.equal(e.gps?.limit_mph, 45); // last known
  assert.equal(e.gps?.limit_source, "osm");
  await s.provider.idle();
});

test("hard acceleration and heading change feed erratic; stopped windows score neither", async () => {
  const s = setup();
  const trip = (await s.svc.startTrip({ driver_id: "g-err", kids_in_car: false, low_experience: false })).trip_id;
  await drive(s, trip, 12, 6);
  // 10 m/s jump inside the window: accel 6 m/s^2 -> erratic 1, smoothed over 3 windows
  const jerky = [12, 12, 12, 12, 12, 12, 12, 12, 18, 18];
  const e = await s.svc.ingestWindow(trip, win(6, { fixes: fixesFor(6, jerky) }));
  assert.ok(e.levels.erratic > 0.3, `erratic ${e.levels.erratic}`);

  // Stopped: median speed under 1 m/s. Even phone motion events are not scored.
  const stopped = setup();
  const t2 = (await stopped.svc.startTrip({ driver_id: "g-stop", kids_in_car: false, low_experience: false })).trip_id;
  let last!: Evaluation;
  for (let i = 0; i < 10; i++) last = await stopped.svc.ingestWindow(t2, win(i, { fixes: fixesFor(i, 0.2) }, { hard_brakes: 5, swerves: 5 }));
  assert.equal(last.gps?.stopped, true);
  assert.equal(last.levels.erratic, 0);
  assert.equal(last.levels.speeding, 0);
});

test("trip starts moving, ends itself after 5 minutes stopped, then refuses windows", async () => {
  const s = setup();
  const trip = (await s.svc.startTrip({ driver_id: "g-life", kids_in_car: false, low_experience: false })).trip_id;
  let i = 0;
  const e0 = await s.svc.ingestWindow(trip, win(i++, { fixes: fixesFor(0, 10) }));
  assert.equal(e0.gps?.moving, false); // 9 s above 4 m/s so far
  const e1 = await s.svc.ingestWindow(trip, win(i++, { fixes: fixesFor(1, 10) }));
  assert.equal(e1.gps?.moving, false); // 19 s
  const e2 = await s.svc.ingestWindow(trip, win(i++, { fixes: fixesFor(2, 10) }));
  assert.equal(e2.gps?.moving, true); // 20 s above 4 m/s: started
  assert.deepEqual(s.hooks.map((h) => h.extra.lifecycle), [[], [], ["started"]]);

  let last!: Evaluation;
  for (; i < 3 + 31; i++) last = await s.svc.ingestWindow(trip, win(i, { fixes: fixesFor(i, 0) })); // 330 s stopped
  assert.equal(last.gps?.trip_ended, true);
  assert.ok((await store.getTrip(trip))!.endedAt);
  assert.ok(await store.getCard(trip), "ending writes the report card");
  assert.deepEqual(s.hooks.at(-1)!.extra.lifecycle, ["ended"]);
  await assert.rejects(s.svc.ingestWindow(trip, win(i, { fixes: fixesFor(i, 0) })), (err) => err instanceof HttpError && err.status === 409);
});

test("a restart in the middle of a trip keeps start/stop detection (state rebuilt from stored fixes)", async () => {
  const a = setup();
  const trip = (await a.svc.startTrip({ driver_id: "g-restart", kids_in_car: false, low_experience: false })).trip_id;
  for (let i = 0; i < 4; i++) await a.svc.ingestWindow(trip, win(i, { fixes: fixesFor(i, 10) }));
  const b = setup(); // fresh service, same database
  let last!: Evaluation;
  for (let i = 4; i < 4 + 31; i++) last = await b.svc.ingestWindow(trip, win(i, { fixes: fixesFor(i, 0) }));
  assert.equal(last.gps?.trip_ended, true);
  assert.equal(last.gps?.moving, false); // phase is "ended"
});

test("location sharing: default on, off when asked, and the choice sticks for the driver", async () => {
  const s = setup();
  const t1 = (await s.svc.startTrip({ driver_id: "g-priv", kids_in_car: false, low_experience: false })).trip_id;
  await s.svc.ingestWindow(t1, win(0, { fixes: fixesFor(0, 10) }));
  assert.equal(s.hooks.at(-1)!.extra.shareLocation, true);
  assert.ok(s.hooks.at(-1)!.extra.location, "the in-process consumers still get the fix for voice");

  const t2 = (await s.svc.startTrip({ driver_id: "g-priv", kids_in_car: false, low_experience: false, share_location: false })).trip_id;
  await s.svc.ingestWindow(t2, win(0, { fixes: fixesFor(0, 10) }));
  assert.equal(s.hooks.at(-1)!.extra.shareLocation, false);
  const t3 = (await s.svc.startTrip({ driver_id: "g-priv", kids_in_car: false, low_experience: false })).trip_id; // omitted keeps it
  await s.svc.ingestWindow(t3, win(0, { fixes: fixesFor(0, 10) }));
  assert.equal(s.hooks.at(-1)!.extra.shareLocation, false);
  assert.equal((await store.getDriver("g-priv"))!.shareLocation, false);
});

test("HTTP: gps null and a full payload are accepted, more than 10 fixes is a 400", async () => {
  const s = setup();
  const server: Server = await new Promise((resolve) => {
    const handle = createRiskRoutes(s.svc);
    const srv = createServer(async (req, res) => {
      if (!(await handle(req, res))) res.writeHead(404).end();
    }).listen(0, () => resolve(srv));
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, body: unknown) => {
      const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const { body: started } = await call("/trips", { driver_id: "g-http" });
    const path = `/trips/${started.trip_id}/windows`;
    assert.equal((await call(path, win(0, null))).status, 200);
    const ok = await call(path, win(1, { fixes: fixesFor(1, 10) }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.gps.ok, true);
    assert.equal(ok.body.gps.lat, undefined, "no coordinates in the response");
    assert.equal((await call(path, win(2, { fixes: [...fixesFor(2, 10), ...fixesFor(2, 10)] }))).status, 400);
  } finally {
    server.close();
  }
});

test("replay a recorded drive (GPX) end to end", async () => {
  const fixes = fixesFromGpx(readFileSync(new URL("./fixtures/drive.gpx", import.meta.url), "utf8"));
  assert.equal(fixes.length, 561);

  const s = setup({ highway: "residential", maxspeed: "25 mph" }); // the drive cruises at 12 m/s (27 mph) then 17 m/s (38 mph)
  const trip = (await s.svc.startTrip({ driver_id: "g-gpx", kids_in_car: false, low_experience: false })).trip_id;
  const evals: Evaluation[] = [];
  for (let w = 0; w * 10 + 10 <= fixes.length; w++) {
    const chunk = fixes.slice(w * 10, w * 10 + 10);
    const ts = new Date(Date.parse(chunk.at(-1)!.t)).toISOString();
    try {
      evals.push(await s.svc.ingestWindow(trip, { ...NEUTRAL, ts, gps: { fixes: chunk } }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) break; // the trip ended itself: a real phone stops sending
      throw err;
    }
    await s.provider.idle();
  }

  // Parked for 30 s, then moving: started was detected, and parked windows are not scored.
  assert.equal(evals[0]!.gps?.stopped, true);
  assert.equal(evals[0]!.levels.speeding, 0);
  assert.ok(evals.some((e) => e.gps?.moving));
  assert.deepEqual(s.hooks.flatMap((h) => h.extra.lifecycle), ["started", "ended"]);

  // 17 m/s on a 25 mph road is 52 percent over -> speeding saturates and raises the tier.
  const peak = Math.max(...evals.map((e) => e.levels.speeding));
  assert.ok(peak > 0.99, `peak speeding ${peak}`);
  assert.ok(evals.some((e) => e.tier >= 1 && e.dominant === "reckless"));
  // The 180 degree turn in 3 s is a heading rate of 60 deg/s -> erratic.
  assert.ok(Math.max(...evals.map((e) => e.levels.erratic)) > 0.3);

  // Ended after the long stop, card written with the route.
  const row = (await store.getTrip(trip))!;
  assert.ok(row.endedAt);
  const card = (await store.getCard(trip))!.card.gps!;
  assert.ok(card.route.length > 40 && card.route.length <= 57, `route points ${card.route.length}`);
  assert.ok(card.alerts.length >= 1);
  assert.ok(card.pct_over_limit > 10 && card.pct_over_limit < 60, `over limit ${card.pct_over_limit}`);
  assert.equal(card.fallback_used, false);
  assert.ok((await store.getGpsSamples(trip)).length >= 500);
});
