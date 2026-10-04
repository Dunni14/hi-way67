// HTTP + Postgres (in-process PGlite) tests: lifecycle, report, feedback, restart replay.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { createRiskRoutes } from "../http/risk.ts";
import { PgRiskStore } from "./store/pg.ts";
import { RiskService } from "./service.ts";

const T0 = Date.parse("2026-10-03T20:00:00Z");
const NEUTRAL = {
  face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};
const AGITATED = { emotion_stress: 1, heart_rate: 95 };

let db: PGlite;
let store: PgRiskStore;
let server: Server;
let base: string;

const start = (svc: RiskService) =>
  new Promise<void>((resolve) => {
    const handle = createRiskRoutes(svc);
    server = createServer(async (req, res) => {
      if (!(await handle(req, res))) res.writeHead(404).end();
    }).listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

before(async () => {
  db = new PGlite();
  store = new PgRiskStore(db);
  await store.migrate();
  await store.migrate(); // idempotent
  await start(new RiskService(store));
});
after(async () => {
  server.close();
  await db.close();
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
};
const startTrip = async (driver: string, extra: object = {}) =>
  (await call("POST", "/trips", { driver_id: driver, ...extra })).body.trip_id as string;
const sendWindow = (trip: string, i: number, o: object = {}) =>
  call("POST", `/trips/${trip}/windows`, { ...NEUTRAL, ts: new Date(T0 + i * 10_000).toISOString(), ...o });

async function drive(trip: string, scenario: object, n: number, from = 0) {
  let last: any;
  for (let i = from; i < from + n; i++) {
    last = await sendWindow(trip, i, i < 6 ? { ...scenario, heart_rate: 70, breathing_rate: 15 } : scenario);
  }
  return last;
}

test("trip lifecycle, state, report with grade B, driver history", async () => {
  const trip = await startTrip("alice");
  const last = await drive(trip, AGITATED, 12);
  assert.equal(last.status, 200);
  assert.equal(last.body.tier, 1);
  assert.equal(last.body.dominant, "reckless");

  const state = await call("GET", `/trips/${trip}/state`);
  assert.deepEqual(state.body, last.body);

  await call("POST", `/trips/${trip}/end`);
  const rep = (await call("GET", `/trips/${trip}/report`)).body;
  assert.equal(rep.grade, "B");
  assert.equal(rep.series.length, 12);
  assert.ok(rep.events.length >= 1 && rep.events[0].actions.includes("voice_nudge"));
  assert.ok(rep.max_score > 58 && rep.max_score < 59);
  assert.equal(rep.time_in_tier_s[1] + rep.time_in_tier_s[0], 120);

  const hist = await call("GET", "/drivers/alice/trips");
  assert.equal(hist.body.length, 1);
  assert.equal(hist.body[0].grade, "B");
  assert.equal((await sendWindow(trip, 99)).status, 409); // ended
});

test("grade A with neutral driving, D after a microsleep", async () => {
  const a = await startTrip("bob");
  await drive(a, {}, 10);
  assert.equal((await call("GET", `/trips/${a}/report`)).body.grade, "A");

  const d = await startTrip("carol");
  await drive(d, {}, 6); // baseline
  const hit = await sendWindow(d, 6, { longest_eye_closure_s: 2 });
  assert.equal(hit.body.tier, 3);
  assert.equal(hit.body.override, "microsleep");
  assert.equal((await call("GET", `/trips/${d}/report`)).body.grade, "D");
});

test("feedback changes the next score for that driver only", async () => {
  const sc = { speed_mph: 90, speed_limit_mph: 70 };
  const score = async (driver: string) => {
    const t = await startTrip(driver);
    return (await drive(t, sc, 10)).body.score as number;
  };
  const dave0 = await score("dave");
  const erin0 = await score("erin");
  assert.equal(dave0, erin0);

  const t = await startTrip("dave");
  await drive(t, sc, 10);
  const fb = await call("POST", `/trips/${t}/feedback`, { window_ts: new Date(T0 + 9 * 10_000).toISOString(), verdict: "false_alarm" });
  assert.equal(fb.body.factor, "speeding");
  assert.ok(Math.abs(fb.body.multiplier - 0.95) < 1e-9);

  assert.ok((await score("dave")) < dave0);
  assert.equal(await score("erin"), erin0);
});

test("feedback multiplier is clamped to 0.5x..1.5x", async () => {
  const t = await startTrip("frank");
  await drive(t, { speed_mph: 90, speed_limit_mph: 70 }, 10);
  let m = 1;
  for (let i = 0; i < 20; i++) m = (await call("POST", `/trips/${t}/feedback`, { window_ts: new Date(T0 + 9 * 10_000).toISOString(), verdict: "confirmed" })).body.multiplier;
  assert.equal(m, 1.5);
  for (let i = 0; i < 40; i++) m = (await call("POST", `/trips/${t}/feedback`, { window_ts: new Date(T0 + 9 * 10_000).toISOString(), verdict: "false_alarm" })).body.multiplier;
  assert.equal(m, 0.5);
});

test("sharing off swaps notify_contacts for ask_permission_to_notify", async () => {
  const t = await startTrip("gina", { sharing_mode: "never" });
  const r = await drive(t, { ...AGITATED, speed_mph: 90, speed_limit_mph: 70 }, 8);
  const rep = (await call("GET", `/trips/${t}/report`)).body;
  const acts = rep.events.flatMap((e: any) => e.actions);
  assert.ok(acts.includes("ask_permission_to_notify") && !acts.includes("notify_contacts"));
  assert.equal(r.status, 200);
});

test("a restarted service replays stored windows and keeps cooldown state", async () => {
  const t = await startTrip("hank");
  await drive(t, AGITATED, 9); // tier-1 voice already fired
  server.close();
  await start(new RiskService(store)); // fresh in-memory runtime
  const r = await sendWindow(t, 9, AGITATED);
  assert.equal(r.body.tier, 1);
  assert.deepEqual(r.body.actions, ["none"]); // still inside the 120 s cooldown
});

test("validation and not-found errors", async () => {
  assert.equal((await call("POST", "/trips", {})).status, 400);
  assert.equal((await call("POST", "/trips/nope/windows", { ...NEUTRAL, ts: "2026-10-03T20:00:00Z" })).status, 404);
  const t = await startTrip("ivy");
  assert.equal((await call("POST", `/trips/${t}/windows`, { ts: "not a date" })).status, 400);
  assert.equal((await sendWindow(t, 0)).status, 200);
  assert.equal((await sendWindow(t, 0)).status, 409); // duplicate ts
  assert.equal((await call("GET", `/trips/${t}/state`)).status, 200);
  assert.equal((await call("GET", "/trips/nope/state")).status, 404);
});

test("trip end stores a report card, observations and moves the driver profile", async () => {
  const bad = { speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 };
  const t = await startTrip("iris");
  await drive(t, bad, 70);
  const end = (await call("POST", `/trips/${t}/end`)).body;
  assert.equal(end.ended, true);
  assert.ok(end.card.score < 40 && end.card.confidence === 1 && !end.card.provisional);
  assert.equal(end.card.expression.dominant, "stressed");

  const obs = (await call("GET", `/trips/${t}/observations`)).body;
  assert.equal(obs.length, 70);
  assert.equal(obs[69].expression, "stressed");

  assert.deepEqual((await call("GET", `/trips/${t}/card`)).body.features, end.card.features);
  assert.equal((await call("POST", `/trips/${t}/end`)).body.card.score, end.card.score); // idempotent, profile not re-applied

  const p = (await call("GET", "/drivers/iris/profile")).body;
  assert.equal(p.scoredTrips, 1);
  assert.ok(p.careIndex < 75);
  assert.ok(p.notify_threshold < p.default_notify_threshold);

  const hist = (await call("GET", "/drivers/iris/trips")).body;
  assert.equal(hist[0].card_grade, end.card.grade);

  const rep = (await call("GET", `/trips/${t}/report`)).body;
  assert.equal(rep.card.score, end.card.score);
});

test("feedback on a notification rewards the logged decision and shifts the threshold", async () => {
  const t = await startTrip("jack");
  await drive(t, { speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 }, 12);
  const rows = (await db.query(`SELECT ts, action, context FROM decision_log WHERE trip_id = $1 AND action = 'notify_contacts'`, [t])).rows as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context.length, 8);
  const before = (await call("GET", "/drivers/jack/profile")).body.notify_threshold;
  await call("POST", `/trips/${t}/feedback`, { window_ts: new Date(rows[0].ts).toISOString(), verdict: "false_alarm" });
  const after = (await call("GET", "/drivers/jack/profile")).body;
  assert.equal(after.notify_threshold, before + 2);
  const reward = ((await db.query(`SELECT reward FROM decision_log WHERE trip_id = $1 AND action = 'notify_contacts'`, [t])).rows as any[])[0].reward;
  assert.equal(reward, -1);
});
