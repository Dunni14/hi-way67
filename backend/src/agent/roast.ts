// Roast state: idle -> collecting (after the roast call is posted) -> idle
// (when the driver talks back, or the window times out).
import { config } from "../config.ts";
import { trip } from "../trip/state.ts";

class Roast {
  private startedAt = 0;
  private roastsPlayed = 0;

  get active() {
    return this.startedAt > 0 && Date.now() - this.startedAt < config.roastWindowMs;
  }

  /** Whether the driver has heard at least one roast this round. */
  get heardOne() {
    return this.active && this.roastsPlayed > 0;
  }

  start() {
    this.startedAt = Date.now();
    this.roastsPlayed = 0;
  }

  played() {
    this.roastsPlayed++;
  }

  resolve() {
    this.startedAt = 0;
  }

  /** "Alex has yawned 3 times in 4 minutes at 70 mph. Roast him awake." */
  callText(): string {
    const d = trip.driverName;
    const yawns = trip.countEvents("yawn", 4 * 60_000);
    const nods = trip.countEvents("nod", 4 * 60_000);
    const speed = Math.round(trip.latest?.speed ?? 0);
    const evidence = [
      yawns ? `yawned ${yawns} time${yawns === 1 ? "" : "s"}` : "",
      nods ? `nodded off ${nods} time${nods === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" and ");
    const at = speed > 5 ? ` at ${speed} mph` : "";
    const lead = evidence ? `🚨 ${d} has ${evidence} in the last 4 minutes${at}.` : `🚨 ${d} is getting dangerously drowsy${at}.`;
    return `${lead} Roast ${d} awake! Reply here and I'll read it out loud.`;
  }
}

export const roast = new Roast();
