// Posted limit (Overpass), rest stops, reverse geocoding and the report card route: all with a fake network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { riskConfig } from "../risk/config.ts";
import { placeName, reverseGeocode } from "./geocode.ts";
import { RestStopFinder, pickStop } from "./restStop.ts";
import { buildGpsCard } from "./route.ts";
import { limitForWay, parseMaxspeed, pickWay, SpeedLimitProvider } from "./speedLimit.ts";
import type { FetchLike, OsmElement } from "./overpass.ts";
import { mphToMps } from "./types.ts";

const cfgWith = (lookup: Partial<typeof riskConfig.gps.lookup>) => ({ ...riskConfig, gps: { ...riskConfig.gps, lookup: { ...riskConfig.gps.lookup, ...lookup } } });
const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} != ${b}`);

/** An E-W way through the queried point, so a car driving east always has a matching road under it. */
const eastWestWay = (tags: Record<string, string>): FetchLike => {
  return async (_url, init) => {
    const [, lat, lon] = /around:\d+,([-\d.]+),([-\d.]+)/.exec(decodeURIComponent(init!.body!))!;
    const la = Number(lat);
    const lo = Number(lon);
    const way: OsmElement = { type: "way", id: 1, tags, geometry: [{ lat: la, lon: lo - 0.001 }, { lat: la, lon: lo + 0.001 }] };
    return { ok: true, status: 200, json: async () => ({ elements: [way] }) };
  };
};
const counting = (inner: FetchLike) => {
  const fn: FetchLike & { calls: number } = Object.assign(async (url: string, init?: Parameters<FetchLike>[1]) => (fn.calls++, inner(url, init)), { calls: 0 });
  return fn;
};
/** Never answers, but honours the abort signal like real fetch. */
const hanging: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

test("maxspeed parsing: bare numbers are km/h, mph is kept, anything else is unusable", () => {
  near(parseMaxspeed("45 mph"), 45);
  near(parseMaxspeed("50"), 50 / 1.609344);
  near(parseMaxspeed("50 km/h"), 50 / 1.609344);
  for (const v of ["signals", "none", "30;50", "", undefined, "0"]) assert.equal(parseMaxspeed(v), null);
});

test("a way without maxspeed uses the fallback table and says so; unknown classes give none", () => {
  const f = (tags: Record<string, string>) => limitForWay(tags, riskConfig);
  assert.deepEqual(f({ highway: "residential" }), { limit_mps: mphToMps(25), source: "fallback" });
  assert.deepEqual(f({ highway: "motorway_link" }), { limit_mps: mphToMps(70), source: "fallback" });
  assert.deepEqual(f({ highway: "primary", maxspeed: "signals" }), { limit_mps: mphToMps(55), source: "fallback" });
  assert.deepEqual(f({ highway: "tertiary", maxspeed: "35 mph" }), { limit_mps: mphToMps(35), source: "osm" });
  assert.deepEqual(f({ highway: "service" }), { limit_mps: null, source: "none" });
});

test("the way whose bearing matches the heading wins at an intersection", () => {
  const at = { lat: 42.28, lon: -83.74 };
  const ew: OsmElement = { type: "way", id: 1, tags: { highway: "primary" }, geometry: [{ lat: 42.28, lon: -83.7413 }, { lat: 42.28, lon: -83.7387 }] };
  const ns: OsmElement = { type: "way", id: 2, tags: { highway: "residential" }, geometry: [{ lat: 42.2787, lon: -83.74 }, { lat: 42.2813, lon: -83.74 }] };
  assert.equal(pickWay([ew, ns], at, 92, 25)?.id, 1);
  assert.equal(pickWay([ew, ns], at, 271, 25)?.id, 1); // opposite direction, same road
  assert.equal(pickWay([ew, ns], at, 1, 25)?.id, 2);
  assert.equal(pickWay([ew], { lat: 42.29, lon: -83.74 }, 90, 25), null); // too far away
});

test("lookup never waits: none at first, the fetched limit next time, one fetch per segment", async () => {
  const fetch = counting(eastWestWay({ highway: "primary", maxspeed: "45 mph" }));
  const p = new SpeedLimitProvider(riskConfig, { fetch, endpoints: ["http://a"] });
  assert.deepEqual(p.lookup("t", 42.28, -83.74, 90), { limit_mps: null, source: "none" });
  await p.idle();
  assert.equal(p.lookup("t", 42.28, -83.74, 90).source, "osm");
  assert.equal(p.lookup("t", 42.28001, -83.74001, 90).source, "osm"); // same 4-decimal cell
  assert.equal(fetch.calls, 1);
});

test("a missing maxspeed falls back by highway class", async () => {
  const p = new SpeedLimitProvider(riskConfig, { fetch: eastWestWay({ highway: "residential" }), endpoints: ["http://a"] });
  p.lookup("t", 42.28, -83.74, 90);
  await p.idle();
  const got = p.lookup("t", 42.28, -83.74, 90);
  assert.equal(got.source, "fallback");
  near(got.limit_mps, mphToMps(25));
});

test("an Overpass timeout does not delay the lookup and the last known limit is kept", async () => {
  let mode: "ok" | "hang" = "ok";
  const ok = eastWestWay({ highway: "primary", maxspeed: "45 mph" });
  const fetch = counting((url, init) => (mode === "ok" ? ok(url, init) : hanging(url, init)));
  const p = new SpeedLimitProvider(cfgWith({ timeoutMs: 40 }), { fetch, endpoints: ["http://a"] });
  p.lookup("t", 42.28, -83.74, 90);
  await p.idle();
  assert.equal(p.lookup("t", 42.28, -83.74, 90).source, "osm");

  mode = "hang";
  const started = performance.now();
  const during = p.lookup("t", 42.285, -83.74, 90); // new segment, fetch hangs
  assert.ok(performance.now() - started < 20, "lookup must return immediately");
  assert.equal(during.source, "osm");
  near(during.limit_mps, mphToMps(45));
  await p.idle(); // the hung fetch times out (aborted at 40 ms)
  assert.equal(p.lookup("t", 42.285, -83.74, 90).source, "osm"); // still the last known limit
  const calls = fetch.calls;
  p.lookup("t", 42.29, -83.74, 90); // inside the failure backoff: no new request
  assert.equal(fetch.calls, calls);
});

test("the backup endpoint answers when the primary fails", async () => {
  const good = eastWestWay({ highway: "primary", maxspeed: "30 mph" });
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("primary")) throw new Error("down");
    return good(url, init);
  };
  const p = new SpeedLimitProvider(riskConfig, { fetch, endpoints: ["http://primary", "http://backup"] });
  p.lookup("t", 42.28, -83.74, 90);
  await p.idle();
  near(p.lookup("t", 42.28, -83.74, 90).limit_mps, mphToMps(30));
});

test("trips do not share a last known limit", async () => {
  const p = new SpeedLimitProvider(riskConfig, { fetch: eastWestWay({ highway: "primary", maxspeed: "45 mph" }), endpoints: ["http://a"] });
  p.lookup("a", 42.28, -83.74, 90);
  await p.idle();
  assert.equal(p.lookup("b", 42.5, -83.5, 90).source, "none");
});

test("rest stop: nearest one ahead of the heading, anything within 100 m, none out of range", () => {
  const from = { lat: 42.28, lon: -83.74, heading_deg: 90 };
  const stop = (id: number, lat: number, lon: number, tags: Record<string, string> = { amenity: "fuel" }): OsmElement => ({ type: "node", id, lat, lon, tags });
  const behind = stop(1, 42.28, -83.766, { amenity: "fuel", name: "Behind" }); // ~2.1 km west
  const ahead = stop(2, 42.28, -83.68, { highway: "rest_area", name: "Ahead" }); // ~4.9 km east
  const aheadFar = stop(3, 42.28, -83.6);
  const away = stop(4, 42.5, -83.74); // 24 km north, outside 15 km
  const got = pickStop([behind, aheadFar, ahead, away], from, riskConfig)!;
  assert.equal(got.name, "Ahead");
  assert.equal(got.kind, "rest_area");
  assert.ok(got.distance_m > 4500 && got.distance_m < 5500, String(got.distance_m));
  assert.equal(pickStop([behind], from, riskConfig), null);
  assert.equal(pickStop([behind], { ...from, heading_deg: null }, riskConfig)?.name, "Behind");
  assert.equal(pickStop([stop(5, 42.2803, -83.74)], from, riskConfig)?.kind, "fuel");
});

test("rest stop finder caches and resolves null on failure", async () => {
  const body = { elements: [{ type: "node", id: 1, lat: 42.28, lon: -83.68, tags: { amenity: "fuel", name: "Gas" } }] };
  const fetch = counting(async () => ({ ok: true, status: 200, json: async () => body }));
  const finder = new RestStopFinder(riskConfig, { fetch, endpoints: ["http://a"] });
  const fix = { lat: 42.28, lon: -83.74, heading_deg: 90 };
  assert.equal((await finder.next(fix))?.name, "Gas");
  await finder.next(fix);
  assert.equal(fetch.calls, 1);
  const quick = { ...riskConfig, gps: { ...riskConfig.gps, restStop: { ...riskConfig.gps.restStop, timeoutMs: 40 } } };
  const dead = new RestStopFinder(quick, { fetch: hanging, endpoints: ["http://a"] });
  assert.equal(await dead.next({ lat: 1, lon: 1, heading_deg: null }), null);
});

test("reverse geocode gives road and city, null on failure", async () => {
  assert.equal(placeName({ road: "Main St", city: "Ann Arbor" }), "Main St, Ann Arbor");
  assert.equal(placeName({ road: "County Rd 5", village: "Dexter" }), "County Rd 5, Dexter");
  assert.equal(placeName({ town: "Saline" }), "Saline");
  assert.equal(placeName({}), null);
  const ok: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ address: { road: "State St", city: "Ann Arbor" } }) });
  assert.equal(await reverseGeocode(42.2001, -83.7001, { fetch: ok }), "State St, Ann Arbor");
  const down: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await reverseGeocode(42.3001, -83.8001, { fetch: down }), null);
});

test("gps card: route downsampled to one point per 10 s, markers, limit percentages and the fallback flag", () => {
  const T0 = Date.parse("2026-10-04T05:26:00Z");
  const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
  const lim = mphToMps(25);
  const samples = Array.from({ length: 60 }, (_, s) => ({
    time: iso(s), lat: 42.28, lon: -83.74 + s * 1e-4, speedMps: s < 15 ? lim * 1.2 : lim * 0.8, limitMps: lim, limitSource: s < 30 ? "fallback" : "osm",
  }));
  const card = buildGpsCard(samples, [{ ts: iso(21), tier: 2 }, { ts: iso(500), tier: 3 }, { ts: iso(30), tier: 0 }])!;
  assert.equal(card.route.length, 6);
  assert.equal(card.route[1]!.t, iso(10));
  assert.deepEqual(card.alerts, [{ t: iso(21), tier: 2, lat: 42.28, lon: samples[21]!.lon }]); // far-away and tier 0 events get no marker
  assert.equal(card.pct_over_limit, 25);
  assert.equal(card.pct_fallback_limit, 50);
  assert.equal(card.fallback_used, true);
  assert.match(card.limit_note!, /50%/);
  const osmOnly = buildGpsCard(samples.map((s) => ({ ...s, limitSource: "osm" })), [])!;
  assert.equal(osmOnly.fallback_used, false);
  assert.equal(osmOnly.limit_note, null);
  assert.equal(buildGpsCard([], []), null);
});
