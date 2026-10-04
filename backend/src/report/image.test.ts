// The report image: valid PNG at the expected size, for a good drive, a bad one and an empty one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { riskConfig as cfg } from "../risk/config.ts";
import { buildCard, type CardWindow } from "../risk/card.ts";
import { initialState, processWindow } from "../risk/decision.ts";
import { observe } from "../risk/expression.ts";
import type { SignalWindow, TripContext } from "../risk/types.ts";
import { renderReportImage, renderReportSvg } from "./image.ts";

const T0 = Date.parse("2026-10-03T20:00:00Z");
const NEUTRAL: SignalWindow = {
  ts: "", face_visible: true, heart_rate: 70, breathing_rate: 15, engagement: 1, eye_closure_frac: 0, longest_eye_closure_s: 0,
  yawns: 0, emotion_stress: 0, gaze_off_road_s: 0, phone_in_hand: false, hard_brakes: 0, swerves: 0, speed_mph: 60, speed_limit_mph: 70,
};
const ctx: TripContext = { kidsInCar: false, lowExperience: false, sleepHours: null, sharingOn: true };

function cardFor(scenario: Partial<SignalWindow>, n: number) {
  let state = initialState();
  const windows: CardWindow[] = [];
  for (let i = 0; i < n; i++) {
    const w = { ...NEUTRAL, ...(i < cfg.baselineWindows ? {} : scenario), ts: new Date(T0 + i * 10_000).toISOString() };
    const r = processWindow(state, w, ctx, cfg);
    state = r.state;
    windows.push({ ts: w.ts, score: r.evaluation.score, tier: r.evaluation.tier, result: r.evaluation, raw: w });
  }
  return buildCard(windows, windows.map((w) => observe(w.raw, cfg)), ctx, cfg);
}

const size = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

test("renders a PNG for a clean drive, a reckless one and a tiny one", async () => {
  for (const [name, card] of [
    ["clean", cardFor({}, 40)],
    ["reckless", cardFor({ speed_mph: 95, phone_in_hand: true, emotion_stress: 1, heart_rate: 100 }, 40)],
    ["tiny", cardFor({}, 3)],
  ] as const) {
    const png = await renderReportImage(card, { driverName: "Alex", startedAt: T0 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name}: PNG signature`);
    assert.deepEqual(size(png), { w: 1080, h: 1960 }, name);
    assert.ok(png.length > 20_000 && png.length < 400_000, `${name}: ${png.length} bytes`);
  }
});

test("the image differs with the data, and a long name does not break the layout", async () => {
  const good = await renderReportImage(cardFor({}, 40), { driverName: "Alex" });
  const bad = await renderReportImage(cardFor({ speed_mph: 95, phone_in_hand: true }, 40), { driverName: "Alex" });
  assert.notDeepEqual(good, bad);
  const long = await renderReportImage(cardFor({}, 40), { driverName: "Maximilian Alexander Featherstonehaugh", startedAt: null });
  assert.deepEqual(size(long), { w: 1080, h: 1960 });
});

test("the SVG rasterizes to the same size and carries no external references", async () => {
  const svg = await renderReportSvg(cardFor({}, 40), { driverName: "Alex" });
  assert.ok(!/href=|url\(http/i.test(svg.replace(/url\(#[^)]*\)/g, "")));
  const out = new Resvg(svg).render();
  assert.equal(out.width, 1080);
});
