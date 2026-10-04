// Trip start and stop detection from fixes. Pure: state in, state out, the fix times are the clock.
//   start: speed above startSpeedMps continuously for startHoldS
//   end:   speed under stopSpeedMps continuously for stopHoldS (only once the trip has started)
import type { RiskConfig } from "../risk/config.ts";
import type { GoodFix } from "./types.ts";

export type Motion = {
  phase: "idle" | "moving" | "ended";
  /** Time the current run above the start speed began. */
  fastSince: number | null;
  /** Time the current run under the stop speed began. */
  slowSince: number | null;
};

export const initialMotion = (): Motion => ({ phase: "idle", fastSince: null, slowSince: null });

export type MotionEvent = "started" | "ended";

export function advanceMotion(prev: Motion, fixes: GoodFix[], cfg: RiskConfig): { state: Motion; events: MotionEvent[] } {
  const T = cfg.gps.trip;
  const s = { ...prev };
  const events: MotionEvent[] = [];
  for (const f of fixes) {
    if (s.phase === "ended") break;
    if (s.phase === "idle") {
      if (f.speed_mps > T.startSpeedMps) {
        s.fastSince ??= f.ms;
        if (f.ms - s.fastSince >= T.startHoldS * 1000) {
          s.phase = "moving";
          s.fastSince = null;
          s.slowSince = null;
          events.push("started");
        }
      } else s.fastSince = null;
    } else {
      if (f.speed_mps < T.stopSpeedMps) {
        s.slowSince ??= f.ms;
        if (f.ms - s.slowSince >= T.stopHoldS * 1000) {
          s.phase = "ended";
          events.push("ended");
        }
      } else s.slowSince = null;
    }
  }
  return { state: s, events };
}
