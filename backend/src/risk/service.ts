// Orchestrates the pure core and the store. No ElevenLabs / Photon calls here:
// it returns actions and callers (client, orchestrator) act on them.
import { randomUUID } from "node:crypto";
import type { BanditService, Intervention } from "../bandit/service.ts";
import { riskConfig, type RiskConfig } from "./config.ts";
import { initialState, processWindow, type EngineState } from "./decision.ts";
import { defaultMults, dominantFactor } from "./score.ts";
import type { RiskStore, TripRow } from "./store/types.ts";
import { FACTORS, type Evaluation, type Factor, type Feedback, type SharingMode, type SignalWindow, type Tier, type TripContext, type TripStart, type WeightMults } from "./types.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const GRADES = ["A", "B", "C", "D"] as const;
const WINDOW_S = 10;

type Runtime = { state: EngineState; ctx: TripContext };

export class RiskService {
  private runtimes = new Map<string, Runtime>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private store: RiskStore,
    private cfg: RiskConfig = riskConfig,
    /** Optional hook for in-process consumers (the orchestrator). Failures never affect the response. */
    private onEvaluation?: (tripId: string, ev: Evaluation, intervention?: Intervention) => void | Promise<void>,
    /** Optional adaptive-recommendation layer (needs TIGER_DATABASE_URL). Never changes tiers or actions. */
    private bandit?: BanditService,
  ) {}

  async startTrip(body: TripStart & { sharing_mode?: SharingMode }) {
    await this.store.upsertDriver(body.driver_id, body.sharing_mode);
    const id = randomUUID();
    await this.store.createTrip({
      id,
      driverId: body.driver_id,
      startedAt: new Date().toISOString(),
      kidsInCar: body.kids_in_car,
      lowExperience: body.low_experience,
      sleepHours: body.sleep_hours ?? null,
    });
    return { trip_id: id };
  }

  /** Windows for one trip are processed strictly in arrival order. */
  ingestWindow(tripId: string, w: SignalWindow): Promise<Evaluation & { intervention?: Intervention }> {
    const prev = this.chains.get(tripId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.ingest(tripId, w));
    this.chains.set(tripId, next);
    return next;
  }

  private async ingest(tripId: string, w: SignalWindow): Promise<Evaluation & { intervention?: Intervention }> {
    const trip = await this.mustTrip(tripId);
    if (trip.endedAt) throw new HttpError(409, "trip already ended");
    if (Number.isNaN(Date.parse(w.ts))) throw new HttpError(400, "invalid ts");
    const ts = new Date(w.ts).toISOString();
    const driver = await this.store.getDriver(trip.driverId);
    const mults = { ...defaultMults(), ...driver?.weightOverrides };
    const rt = await this.runtime(trip, driver?.sharingMode, mults);
    rt.ctx.sharingOn = driver?.sharingMode !== "never";

    const hadBaseline = rt.state.baseline != null;
    const { evaluation, state } = processWindow(rt.state, { ...w, ts }, rt.ctx, this.cfg, mults);
    const stored = await this.store.addWindow({ tripId, ts, raw: { ...w, ts }, result: evaluation, score: evaluation.score, tier: evaluation.tier });
    if (!stored) throw new HttpError(409, "duplicate window ts");
    rt.state = state;

    if (!hadBaseline && state.baseline) await this.store.setBaseline(tripId, state.baseline);
    if (evaluation.actions.some((a) => a !== "none")) {
      await this.store.addEvent({ tripId, ts, tier: evaluation.tier, actions: evaluation.actions, override: evaluation.override });
    }
    const rec = this.bandit ? await this.recommend(trip, evaluation, ts) : {};
    try {
      void Promise.resolve(this.onEvaluation?.(tripId, evaluation, rec.intervention)).catch((e) => console.error("[risk] onEvaluation:", e));
    } catch (e) {
      console.error("[risk] onEvaluation:", e);
    }
    return { ...evaluation, ...rec };
  }

  /** Settle due rewards (from scored windows only: baseline windows carry no levels), then pick an intervention for a tier 1/2 voice action. A bandit failure never breaks the response. */
  private async recommend(trip: TripRow, ev: Evaluation, ts: string): Promise<{ intervention?: Intervention }> {
    try {
      await this.bandit!.processRewards({ trip, nowTs: ts, windows: async () => (await this.store.getWindows(trip.id)).slice(this.cfg.baselineWindows) });
      const intervention = await this.bandit!.select({ trip, ev, ts });
      return intervention ? { intervention } : {};
    } catch (e) {
      console.error("[bandit]", e);
      return {};
    }
  }

  /** Active-trip runtime; after a restart it is rebuilt by replaying stored windows (the core is deterministic). */
  private async runtime(trip: TripRow, sharing: SharingMode | undefined, mults: WeightMults): Promise<Runtime> {
    const hit = this.runtimes.get(trip.id);
    if (hit) return hit;
    const ctx: TripContext = { kidsInCar: trip.kidsInCar, lowExperience: trip.lowExperience, sleepHours: trip.sleepHours, sharingOn: sharing !== "never" };
    let state = initialState();
    for (const row of await this.store.getWindows(trip.id)) state = processWindow(state, row.raw, ctx, this.cfg, mults).state;
    const rt = { state, ctx };
    this.runtimes.set(trip.id, rt);
    return rt;
  }

  async feedback(tripId: string, fb: Feedback) {
    const trip = await this.mustTrip(tripId);
    const win = await this.store.getWindow(tripId, new Date(fb.window_ts).toISOString());
    if (!win) throw new HttpError(404, "no window at window_ts");
    const driver = await this.store.getDriver(trip.driverId);
    const mults: WeightMults = { ...defaultMults(), ...driver?.weightOverrides };

    const factor: Factor = dominantFactor(win.result.levels, this.cfg, mults);
    const F = this.cfg.feedback;
    const step = fb.verdict === "false_alarm" ? F.falseAlarm : F.confirmed;
    mults[factor] = Math.min(F.max, Math.max(F.min, mults[factor] * step));
    await this.store.setWeightOverrides(trip.driverId, Object.fromEntries(FACTORS.map((f) => [f, mults[f]])));
    if (fb.verdict === "false_alarm") await this.bandit?.markFalseAlarm(tripId, new Date(fb.window_ts).toISOString()).catch((e) => console.error("[bandit]", e));
    return { factor, multiplier: mults[factor] };
  }

  async endTrip(tripId: string) {
    const trip = await this.mustTrip(tripId);
    if (!trip.endedAt) await this.store.endTrip(tripId, new Date().toISOString());
    this.runtimes.delete(tripId);
    this.chains.delete(tripId);
    return { trip_id: tripId, ended: true };
  }

  async state(tripId: string): Promise<Evaluation> {
    await this.mustTrip(tripId);
    const rows = await this.store.getWindows(tripId);
    const latest = rows.at(-1);
    if (!latest) throw new HttpError(404, "no windows yet");
    return latest.result;
  }

  async report(tripId: string) {
    const trip = await this.mustTrip(tripId);
    const [windows, events] = await Promise.all([this.store.getWindows(tripId), this.store.getEvents(tripId)]);
    return { trip_id: tripId, driver_id: trip.driverId, started_at: trip.startedAt, ended_at: trip.endedAt, ...summarize(windows), events };
  }

  async driverTrips(driverId: string) {
    const trips = await this.store.listTrips(driverId);
    return Promise.all(
      trips.map(async (t) => {
        const s = summarize(await this.store.getWindows(t.id));
        return { trip_id: t.id, started_at: t.startedAt, ended_at: t.endedAt, max_score: s.max_score, grade: s.grade };
      }),
    );
  }

  async driverPolicy(driverId: string) {
    if (!this.bandit) throw new HttpError(404, "adaptive recommendations disabled (TIGER_DATABASE_URL not set)");
    return this.bandit.policy(driverId);
  }

  private async mustTrip(id: string) {
    const trip = await this.store.getTrip(id);
    if (!trip) throw new HttpError(404, "trip not found");
    return trip;
  }
}

/** Series, max score, time per tier and letter grade (A: tier 0 only … D: reached tier 3). */
function summarize(windows: { ts: string; score: number; tier: Tier }[]) {
  const timeInTier: Record<Tier, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  windows.forEach((w, i) => {
    const next = windows[i + 1];
    timeInTier[w.tier] += next ? (Date.parse(next.ts) - Date.parse(w.ts)) / 1000 : WINDOW_S;
  });
  const maxTier = windows.reduce<Tier>((m, w) => (w.tier > m ? w.tier : m), 0);
  return {
    series: windows.map((w) => ({ ts: w.ts, score: w.score, tier: w.tier })),
    max_score: windows.reduce((m, w) => Math.max(m, w.score), 0),
    time_in_tier_s: timeInTier,
    grade: GRADES[maxTier],
  };
}
