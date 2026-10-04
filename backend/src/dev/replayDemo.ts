// Replays the app's demo-mode windows through the real risk engine and prints when each tier fires.
//   cd ../frontend && ./gradlew :core:test      (writes core/build/demo-windows.json)
//   npx tsx src/dev/replayDemo.ts [path]
// Uses the in-process fake database, so nothing is persisted.
import { readFileSync } from "node:fs";
import { openFakeDb } from "./fakeDb.ts";

const path = process.argv[2] ?? new URL("../../../frontend/core/build/demo-windows.json", import.meta.url);
const windows = JSON.parse(readFileSync(path, "utf8")) as { ts: number; speed: number; signals: Record<string, unknown> }[];

const { service } = await openFakeDb({ seed: false });
const { trip_id } = await service.startTrip({ driver_id: "demo-replay", kids_in_car: false, low_experience: false });
const t0 = windows[0]!.ts - 10_000 / 12; // first window closes ~0.8 s into the trip

for (const [i, w] of windows.entries()) {
  const ev = await service.ingestWindow(trip_id, { ...w.signals, ts: new Date(w.ts).toISOString() } as never);
  const acts = ev.actions.filter((a) => a !== "none");
  const real = ((w.ts - t0) / 1000).toFixed(1).padStart(5);
  if (acts.length || i === windows.length - 1 || ev.tier > 0) {
    console.log(`window ${String(i + 1).padStart(2)}  t=${real}s  tier ${ev.tier}  score ${ev.score.toFixed(1)}  drowsy ${ev.levels.drowsy.toFixed(2)}` +
      `${ev.override ? `  override=${ev.override}` : ""}${acts.length ? `  -> ${acts.join(", ")}` : ""}`);
  }
}
