// Adaptive recommendations: pure LinUCB / reward math, then the service on in-process Postgres (PGlite).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PgRiskStore } from "../risk/store/pg.ts";
import { RiskService } from "../risk/service.ts";
import { banditConfig } from "./config.ts";
import { choose, initModel, solve, update } from "./linucb.ts";
import { allowedActions, computeReward } from "./reward.ts";
import { PgBanditStore } from "./store.ts";
import { BanditService } from "./service.ts";
import { gradeOf, interventionLine } from "../voice/lines.ts";
import { policyFacts } from "../agent/answer.ts";

const cfg = banditConfig;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// --- pure ---------------------------------------------------------------

test("solve matches a known system", () => {
  const y = solve([2, 1, 1, 3], [5, 10]); // 2a+b=5, a+3b=10 -> a=1, b=3
  near(y[0]!, 1);
  near(y[1]!, 3);
});

test("reward: 0.8 -> 0.5 is 1, 0.6 -> 0.6 is 0", () => {
  const base = { stoppedAfterDrowsy: false, falseAlarm: false, tierWentUp: false };
  near(computeReward({ ...base, before: [0.8, 0.8], after: [0.5, 0.5, 0.5] }, cfg)!, 1);
  near(computeReward({ ...base, before: [0.6, 0.6], after: [0.6, 0.6, 0.6] }, cfg)!, 0);
  near(computeReward({ ...base, before: [0.1], after: [0.9] }, cfg)!, -1);
});

test("reward adjustments are added then clamped to [-1, 2]", () => {
  const base = { before: [0.8], after: [0.5], stoppedAfterDrowsy: false, falseAlarm: false, tierWentUp: false };
  near(computeReward({ ...base, stoppedAfterDrowsy: true }, cfg)!, 2);
  near(computeReward({ ...base, falseAlarm: true }, cfg)!, 0.5);
  near(computeReward({ ...base, tierWentUp: true, falseAlarm: true }, cfg)!, 0);
  near(computeReward({ ...base, before: [0.1], after: [0.9], tierWentUp: true }, cfg)!, -1);
  assert.equal(computeReward({ ...base, after: [] }, cfg), null);
});

test("allowed actions follow tier and dominant state; family voice only when configured", () => {
  const reckless1 = allowedActions(cfg, 1, "reckless", true);
  assert.deepEqual(reckless1.sort(), ["breathing_prompt", "calm_slowdown", "report_card_reminder"]);
  for (const t of [1, 2] as const) for (const a of allowedActions(cfg, t, "reckless", true)) assert.notEqual(cfg.actions[a]!.dominant, "drowsy");
  assert.ok(allowedActions(cfg, 2, "drowsy", true).includes("family_voice_warning"));
  assert.ok(!allowedActions(cfg, 2, "drowsy", false).includes("family_voice_warning"));
  assert.ok(!allowedActions(cfg, 2, "reckless", false).includes("family_voice_warning"));
});

test("fresh models pick the tier default; ties go to the default", () => {
  const x = [1, 0.5, 0, 0, 0.1, 0, 0, 0];
  const allowed = allowedActions(cfg, 1, "drowsy", false);
  const models = Object.fromEntries(allowed.map((a) => [a, initModel(8, a === "calm_checkin" ? cfg.defaultBias : 0)]));
  assert.equal(choose(models, allowed, x, cfg.alpha, "calm_checkin").action, "calm_checkin");
  const flat = Object.fromEntries(allowed.map((a) => [a, initModel(8)]));
  assert.equal(choose(flat, allowed, x, cfg.alpha, "suggest_music").action, "suggest_music");
});

test("five -1 rewards on calm_checkin and one +1 on start_conversation flips the pick", () => {
  const x = [1, 0.5, 0, 0, 0.1, 1, 0, 0];
  const allowed = allowedActions(cfg, 1, "drowsy", false);
  const models = Object.fromEntries(allowed.map((a) => [a, initModel(8, a === "calm_checkin" ? cfg.defaultBias : 0)]));
  for (let i = 0; i < 5; i++) models.calm_checkin = update(models.calm_checkin!, x, -1);
  models.start_conversation = update(models.start_conversation!, x, 1);
  assert.equal(choose(models, allowed, x, cfg.alpha, "calm_checkin").action, "start_conversation");
  assert.equal(models.calm_checkin!.updates, 5);
});

// --- service on PGlite ----------------------------------------------------

const T0 = Date.parse("2026-10-03T20:00:00Z");
const NEUTRAL = {
  face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};
// With 4 h of sleep: tier 1 (nudge) at window 7, then tier 2 (sustained drowsy override) at window 10.
const DROWSY = { eye_closure_frac: 0.3, yawns: 1, engagement: 0.6, breathing_rate: 12 };
const AGITATED = { emotion_stress: 1, heart_rate: 95 };

let db: PGlite;
let svc: RiskService;
let riskStore: PgRiskStore;
let bandit: BanditService;

before(async () => {
  db = new PGlite();
  const store = (riskStore = new PgRiskStore(db));
  await store.migrate();
  const banditStore = new PgBanditStore(db);
  await banditStore.migrate();
  await banditStore.migrate(); // idempotent
  bandit = new BanditService(banditStore);
  svc = new RiskService(store, undefined, undefined, bandit);
});
after(() => db.close());

const startTrip = async (driver: string, extra: object = {}) => (await svc.startTrip({ driver_id: driver, kids_in_car: false, low_experience: false, sleep_hours: 4, ...extra })).trip_id;
const win = (trip: string, i: number, o: object = {}) => svc.ingestWindow(trip, { ...NEUTRAL, ts: new Date(T0 + i * 10_000).toISOString(), ...o });

/** Windows [from, to] inclusive; the first 6 are always neutral (baseline). Returns every response. */
async function drive(trip: string, scenario: object, to: number, from = 0) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(await win(trip, i, i < 6 ? {} : scenario));
  return out;
}
const events = async (driver: string) => (await db.query(`SELECT * FROM bandit_events WHERE driver_id = $1 ORDER BY ts`, [driver])).rows as any[];

test("new driver: tier 1 drowsy -> calm_checkin (not learned); tier 2 -> firm_warning; other windows carry no intervention", async () => {
  const trip = await startTrip("newbie");
  const rs = await drive(trip, DROWSY, 10);
  assert.equal(rs[6]!.intervention, undefined); // tier 0
  assert.equal(rs[8]!.intervention, undefined); // tier 1 but cooldown: no voice action
  assert.equal(rs[7]!.tier, 1);
  assert.deepEqual(rs[7]!.intervention, { id: "calm_checkin", event_ts: new Date(T0 + 7 * 10_000).toISOString(), learned: false });
  assert.equal(rs[10]!.tier, 2);
  assert.equal(rs[10]!.override, "drowsy_sustained_3");
  assert.ok(rs[10]!.actions.includes("voice_warning"));
  assert.equal(rs[10]!.intervention?.id, "firm_warning");
});

test("tier 3 is never learned: tree actions unchanged, no intervention", async () => {
  const trip = await startTrip("sleepy");
  await drive(trip, {}, 5);
  const hit = await win(trip, 6, { longest_eye_closure_s: 2 });
  assert.equal(hit.tier, 3);
  assert.ok(hit.actions.includes("voice_urgent"));
  assert.equal(hit.intervention, undefined);
  assert.equal((await events("sleepy")).length, 0);
});

test("reckless dominant gets a reckless action", async () => {
  const trip = await startTrip("racer", { sleep_hours: null });
  const rs = await drive(trip, AGITATED, 10);
  const iv = rs.find((r) => r.intervention)!.intervention!;
  assert.equal(iv.id, "calm_slowdown");
  assert.notEqual(cfg.actions[iv.id]!.dominant, "drowsy");
});

test("a driver's learning flips their next pick and leaves other drivers alone", async () => {
  // Take a real context vector from a probe driver's first intervention.
  const probe = await startTrip("probe");
  await drive(probe, DROWSY, 7);
  const x: number[] = (await events("probe"))[0].context;
  assert.equal(x.length, 8);
  assert.ok(x.every((v) => v >= 0 && v <= 1), "context features are 0..1");

  const store = new PgBanditStore(db);
  let ck = initModel(8, cfg.defaultBias);
  for (let i = 0; i < 5; i++) ck = update(ck, x, -1);
  await store.saveModel("learner", "calm_checkin", ck);
  await store.saveModel("learner", "start_conversation", update(initModel(8), x, 1));

  const a = await drive(await startTrip("learner"), DROWSY, 7);
  assert.equal(a[7]!.intervention?.id, "start_conversation");
  assert.equal(a[7]!.intervention?.learned, true);

  const b = await drive(await startTrip("untouched"), DROWSY, 7);
  assert.equal(b[7]!.intervention?.id, "calm_checkin");
  assert.equal(b[7]!.intervention?.learned, false);
});

test("reward arrives 120 s later, updates the driver's model once, and shows in the policy", async () => {
  const trip = await startTrip("rewarded");
  await drive(trip, DROWSY, 7);
  assert.equal((await events("rewarded"))[0].reward, null);
  await drive(trip, {}, 18, 8); // driver recovers; window 18 is 110 s after the intervention
  assert.equal((await events("rewarded"))[0].reward, null);
  await drive(trip, {}, 19, 19); // 120 s after
  const ev = (await events("rewarded"))[0];
  assert.equal(typeof ev.reward, "number");
  assert.ok(ev.reward_ts);
  assert.ok(ev.reward > 0, `expected a positive reward, got ${ev.reward}`);

  const pol = await svc.driverPolicy("rewarded");
  const row = pol.actions.find((a) => a.action === "calm_checkin")!;
  assert.equal(row.updates, 1);
  near(row.mean_reward!, ev.reward);
  assert.equal(pol.actions.length, Object.keys(cfg.actions).length);
  await drive(trip, {}, 25, 20); // not applied twice
  assert.equal((await svc.driverPolicy("rewarded")).actions.find((a) => a.action === "calm_checkin")!.updates, 1);
});

test("trip ends 60 s after the intervention: reward stays null, no model update", async () => {
  const trip = await startTrip("quitter");
  await drive(trip, DROWSY, 13); // intervention at window 7, last window 60 s later
  await svc.endTrip(trip);
  const ev = (await events("quitter"))[0];
  assert.equal(ev.reward, null);
  assert.equal(ev.reward_ts, null);
  assert.ok((await svc.driverPolicy("quitter")).actions.every((a) => a.updates === 0));
});

test("face hidden for most of the 120 s: no reward, no update", async () => {
  const trip = await startTrip("hidden");
  await drive(trip, DROWSY, 7);
  await drive(trip, { face_visible: false }, 19, 8);
  const ev = (await events("hidden"))[0];
  assert.equal(ev.reward, null);
  assert.ok(ev.reward_ts, "decision recorded so it is not retried");
  assert.ok((await svc.driverPolicy("hidden")).actions.every((a) => a.updates === 0));
});

test("false_alarm feedback on the intervention lowers its reward by 0.5", async () => {
  const run = async (driver: string, flag: boolean) => {
    const trip = await startTrip(driver);
    await drive(trip, DROWSY, 7);
    if (flag) await svc.feedback(trip, { window_ts: new Date(T0 + 7 * 10_000).toISOString(), verdict: "false_alarm" });
    await drive(trip, {}, 19, 8);
    return (await events(driver))[0].reward as number;
  };
  const plain = await run("fa-no", false);
  const flagged = await run("fa-yes", true);
  near(plain - flagged, 0.5);
});

test("reward ignores baseline windows (they carry no levels)", async () => {
  const trip = await startTrip("baseline-check");
  await drive(trip, DROWSY, 19);
  const ev = (await events("baseline-check"))[0];
  const rows = (await db.query(`SELECT result FROM windows WHERE trip_id = $1 ORDER BY ts`, [trip])).rows.map((r: any) => r.result.levels.drowsy as number);
  // Intervention at window 7: "before" is window 6 only (window 5 is baseline), "after" the last three windows.
  const expected = computeReward(
    { before: [rows[6]!], after: rows.slice(17, 20), stoppedAfterDrowsy: false, falseAlarm: false, tierWentUp: true },
    cfg,
  );
  near(ev.reward, expected!);
});

test("two trips of one driver settling at once both update the model", async () => {
  const a = await startTrip("twin");
  const b = await startTrip("twin");
  await drive(a, DROWSY, 18);
  await drive(b, DROWSY, 18);
  await Promise.all([win(a, 19, DROWSY), win(b, 19, DROWSY)]);
  assert.equal((await svc.driverPolicy("twin")).actions.find((x) => x.action === "calm_checkin")!.updates, 2);
});

test("the in-process hook receives the intervention with the evaluation", async () => {
  const seen: any[] = [];
  const hooked = new RiskService(riskStore, undefined, (_t, ev, extra) => void seen.push({ tier: ev.tier, iv: extra.intervention }), bandit);
  const { trip_id } = await hooked.startTrip({ driver_id: "hooked", kids_in_car: false, low_experience: false, sleep_hours: 4 });
  for (let i = 0; i <= 7; i++) await hooked.ingestWindow(trip_id, { ...NEUTRAL, ...(i < 6 ? {} : DROWSY), ts: new Date(T0 + i * 10_000).toISOString() });
  assert.equal(seen.length, 8);
  assert.equal(seen[7].tier, 1);
  assert.equal(seen[7].iv.id, "calm_checkin");
  assert.equal(seen[0].iv, undefined);
});

test("every configured action has a spoken line; report card uses the grade", () => {
  for (const id of Object.keys(cfg.actions)) assert.ok(interventionLine(id, { grade: "C" }), id);
  assert.equal(interventionLine("nope"), null);
  assert.match(interventionLine("report_card_reminder", { grade: "C" })!, /scoring a C/);
  assert.deepEqual([gradeOf(10), gradeOf(40), gradeOf(70), gradeOf(85)], ["A", "B", "C", "D"]);
});

test("policy facts name the best action only once it has clearly worked", () => {
  const row = (action: string, updates: number, mean_reward: number | null) => ({ action, updates, mean_reward });
  assert.deepEqual(policyFacts("Alex", { actions: [row("start_conversation", 1, 1)] }), []);
  assert.deepEqual(policyFacts("Alex", { actions: [row("calm_checkin", 5, -0.4)] }), []);
  const f = policyFacts("Alex", { actions: [row("calm_checkin", 4, 0.2), row("start_conversation", 3, 0.8)] });
  assert.match(f[0]!, /having a conversation.*Alex/);
});
