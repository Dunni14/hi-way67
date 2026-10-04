// Orchestrates the pure core and the store. No ElevenLabs / Photon calls here:
// it returns actions and callers (client, orchestrator) act on them.
import { randomUUID } from "node:crypto";
import type { BanditService, Intervention } from "../bandit/service.ts";
import { riskConfig, type RiskConfig } from "./config.ts";
import { initialState, processWindow, type EngineState } from "./decision.ts";
import { buildCard, type ReportCard } from "./card.ts";
import { observe } from "./expression.ts";
import { renderReportImage } from "../report/image.ts";
import { applyCard, applyFeedback, normalizeProfile, notifyThreshold } from "./profile.ts";
import { defaultMults, dominantFactor } from "./score.ts";
import type { GpsSampleRow, RiskStore, TripRow } from "./store/types.ts";
import { erraticGpsLevel, isStopped, speedingLevel, windowFeatures, motionBetween } from "../gps/features.ts";
import { advanceMotion, initialMotion, type Motion, type MotionEvent } from "../gps/lifecycle.ts";
import { buildGpsCard } from "../gps/route.ts";
import { SpeedLimitProvider } from "../gps/speedLimit.ts";
import { mpsToMph, type LocationFix } from "../gps/types.ts";
import { FACTORS, type Action, type EngineWindow, type Evaluation, type Factor, type Feedback, type GpsSummary, type SharingMode, type SignalWindow, type Tier, type TripContext, type TripStart, type WeightMults } from "./types.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const GRADES = ["A", "B", "C", "D"] as const;
const WINDOW_S = 10;

type Runtime = { state: EngineState; ctx: TripContext; motion: Motion };

/** Handed to in-process consumers (the orchestrator) next to each evaluation. Never part of an HTTP response. */
export type EvaluationExtra = {
  /** Last good fix of this window, if any. */
  location: LocationFix | null;
  /** The driver's location-sharing setting. Anything bound for Photon must honor it. */
  shareLocation: boolean;
  /** Trip lifecycle changes detected from GPS on this window. */
  lifecycle: MotionEvent[];
  /** The adaptive-recommendation bandit's pick for a tier 1 or 2 voice action. */
  intervention?: Intervention;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export class RiskService {
  private runtimes = new Map<string, Runtime>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private store: RiskStore,
    private cfg: RiskConfig = riskConfig,
    /** Optional hook for in-process consumers (the orchestrator). Failures never affect the response. */
    private onEvaluation?: (tripId: string, ev: Evaluation, extra: EvaluationExtra) => void | Promise<void>,
    /** Optional adaptive-recommendation layer (needs TIGER_DATABASE_URL). Never changes tiers or actions. */
    private bandit?: BanditService,
    /** Posted-limit lookup. Tests inject one with a fake Overpass. */
    private limits: SpeedLimitProvider = new SpeedLimitProvider(cfg),
  ) {}

  async startTrip(body: TripStart & { sharing_mode?: SharingMode }) {
    await this.store.upsertDriver(body.driver_id, body.sharing_mode, body.share_location);
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
    const threshold = notifyThreshold(normalizeProfile(driver?.profile, this.cfg), this.cfg);
    const rt = await this.runtime(trip, driver?.sharingMode, mults, threshold);
    rt.ctx.sharingOn = driver?.sharingMode !== "never";

    const hadBaseline = rt.state.baseline != null;
    const g = this.gpsStep(tripId, w, rt);
    const { gps: _fixes, ...client } = w;
    const win: EngineWindow = { ...client, ts, ...g?.fields };
    const { evaluation, state } = processWindow(rt.state, win, rt.ctx, this.cfg, mults, threshold);
    if (g) evaluation.gps = g.summary;
    const stored = await this.store.addWindow({ tripId, ts, raw: win, result: evaluation, score: evaluation.score, tier: evaluation.tier });
    if (!stored) throw new HttpError(409, "duplicate window ts");
    rt.state = state;
    if (g) {
      rt.motion = g.motion;
      await this.store.addGpsSamples(tripId, g.samples);
    }
    await this.store.addObservation({ tripId, ...observe(win, this.cfg) });

    if (!hadBaseline && state.baseline) await this.store.setBaseline(tripId, state.baseline);
    if (evaluation.actions.some((a) => a !== "none")) {
      await this.store.addEvent({ tripId, ts, tier: evaluation.tier, actions: evaluation.actions, override: evaluation.override });
      await this.store.addDecision({
        tripId, ts, tier: evaluation.tier, dominant: evaluation.dominant, action: mostSevere(evaluation.actions),
        context: [...FACTORS.map((f) => evaluation.levels[f]), Number(rt.ctx.kidsInCar), Number(rt.ctx.lowExperience)],
        scores: { score: evaluation.score, notify_threshold: threshold, override: evaluation.override, actions: evaluation.actions },
      });
    }
    const rec = this.bandit ? await this.recommend(trip, evaluation, ts) : {};
    const extra: EvaluationExtra = { location: g?.location ?? null, shareLocation: driver?.shareLocation ?? true, lifecycle: g?.events ?? [], intervention: rec.intervention };
    try {
      void Promise.resolve(this.onEvaluation?.(tripId, evaluation, extra)).catch((e) => console.error("[risk] onEvaluation:", e));
    } catch (e) {
      console.error("[risk] onEvaluation:", e);
    }
    // Stopped long enough: the trip ends itself, which writes the report card.
    if (g?.events.includes("ended")) await this.endTrip(tripId);
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

  /**
   * GPS for one window: features, posted limit (cache or last known, never a wait), speeding and erratic
   * levels, trip start/stop detection and the rows for gps_samples. Null for a legacy payload without
   * a `gps` field. Reads and returns state; the caller commits `motion` once the window is stored.
   */
  private gpsStep(tripId: string, w: SignalWindow, rt: Runtime) {
    if (w.gps === undefined) return null;
    const cfg = this.cfg;
    const f = windowFeatures(w.gps?.fixes ?? [], cfg);
    const heading = f.last && f.last.speed_mps >= cfg.gps.headingMinSpeedMps ? f.last.heading_deg : null;
    const limit = f.last ? this.limits.lookup(tripId, f.last.lat, f.last.lon, heading) : { limit_mps: null, source: "none" as const };
    const m = advanceMotion(rt.motion, f.good, cfg);
    const stopped = isStopped(f, cfg);

    const fields: Partial<EngineWindow> = {
      gps_speeding: stopped ? 0 : speedingLevel(f.speed_mps, limit.limit_mps, f.gps_ok, cfg),
      gps_erratic: stopped ? 0 : erraticGpsLevel(f, cfg),
      gps_stopped: stopped,
      limit_source: limit.source,
      speed_limit_mph: limit.limit_mps == null ? null : r1(mpsToMph(limit.limit_mps)),
    };
    // GPS speed fills the existing speed input when it is trustworthy; otherwise the phone's value stays.
    if (f.gps_ok && f.speed_mps != null) fields.speed_mph = r1(mpsToMph(f.speed_mps));

    const summary: GpsSummary = {
      ok: f.gps_ok,
      speed_mps: f.speed_mps == null ? null : Math.round(f.speed_mps * 100) / 100,
      limit_mph: limit.limit_mps == null ? null : Math.round(mpsToMph(limit.limit_mps)),
      limit_source: limit.source,
      stopped,
      moving: m.state.phase === "moving",
      ...(m.events.includes("ended") ? { trip_ended: true } : {}),
    };
    const samples: GpsSampleRow[] = f.good.map((fix, i) => {
      const mv = i > 0 ? motionBetween(f.good[i - 1]!, fix, cfg) : null;
      return {
        time: fix.t, lat: fix.lat, lon: fix.lon, speedMps: fix.speed_mps, headingDeg: fix.heading_deg, hAccuracyM: fix.h_accuracy_m,
        accelMps2: mv?.accel ?? null, headingRateDps: mv?.headingRate ?? null, limitMps: limit.limit_mps, limitSource: limit.source,
      };
    });
    const location: LocationFix | null = f.last ? { ms: f.last.ms, lat: f.last.lat, lon: f.last.lon, speed_mps: f.last.speed_mps, heading_deg: f.last.heading_deg } : null;
    return { fields, summary, motion: m.state, events: m.events, samples, location };
  }

  /** Active-trip runtime; after a restart it is rebuilt by replaying stored windows (the core is deterministic). */
  private async runtime(trip: TripRow, sharing: SharingMode | undefined, mults: WeightMults, threshold: number): Promise<Runtime> {
    const hit = this.runtimes.get(trip.id);
    if (hit) return hit;
    const ctx: TripContext = { kidsInCar: trip.kidsInCar, lowExperience: trip.lowExperience, sleepHours: trip.sleepHours, sharingOn: sharing !== "never" };
    let state = initialState();
    for (const row of await this.store.getWindows(trip.id)) state = processWindow(state, row.raw, ctx, this.cfg, mults, threshold).state;
    // Motion state is rebuilt from the stored fixes the same way.
    const fixes = (await this.store.getGpsSamples(trip.id)).map((r) => ({
      ms: Date.parse(r.time), t: r.time, lat: r.lat, lon: r.lon, speed_mps: r.speedMps ?? 0, heading_deg: r.headingDeg, h_accuracy_m: r.hAccuracyM ?? 0,
    }));
    const rt: Runtime = { state, ctx, motion: advanceMotion(initialMotion(), fixes, this.cfg).state };
    this.runtimes.set(trip.id, rt);
    return rt;
  }

  async feedback(tripId: string, fb: Feedback) {
    const trip = await this.mustTrip(tripId);
    const ts = new Date(fb.window_ts).toISOString();
    const win = await this.store.getWindow(tripId, ts);
    if (!win) throw new HttpError(404, "no window at window_ts");
    const driver = await this.store.getDriver(trip.driverId);
    const mults: WeightMults = { ...defaultMults(), ...driver?.weightOverrides };

    const factor: Factor = dominantFactor(win.result.levels, this.cfg, mults);
    const F = this.cfg.feedback;
    const step = fb.verdict === "false_alarm" ? F.falseAlarm : F.confirmed;
    mults[factor] = Math.min(F.max, Math.max(F.min, mults[factor] * step));
    await this.store.setWeightOverrides(trip.driverId, Object.fromEntries(FACTORS.map((f) => [f, mults[f]])));

    // Reinforcement: reward the logged decision; a judged notification also moves the driver's notify threshold.
    const acted = await this.store.rewardDecision(tripId, ts, fb.verdict === "confirmed" ? 1 : -1);
    if (acted === "notify_contacts" || acted === "ask_permission_to_notify") {
      const profile = applyFeedback(normalizeProfile(driver?.profile, this.cfg), fb.verdict, this.cfg);
      await this.store.setProfile(trip.driverId, profile);
    }
    if (fb.verdict === "false_alarm") await this.bandit?.markFalseAlarm(tripId, new Date(fb.window_ts).toISOString()).catch((e) => console.error("[bandit]", e));
    return { factor, multiplier: mults[factor] };
  }

  async endTrip(tripId: string) {
    const trip = await this.mustTrip(tripId);
    const first = !trip.endedAt;
    if (first) await this.store.endTrip(tripId, new Date().toISOString());
    this.runtimes.delete(tripId);
    this.chains.delete(tripId);
    this.limits.forget(tripId);
    // The card is written once, when the trip first ends, and is what moves the driver's profile.
    let stored = await this.store.getCard(tripId);
    if (!stored) {
      const card = await this.buildTripCard(trip);
      const driver = await this.store.getDriver(trip.driverId);
      const before = normalizeProfile(driver?.profile, this.cfg);
      const after = applyCard(before, card, this.cfg);
      card.profile = { care_before: before.careIndex, care_after: after.careIndex, notify_threshold: notifyThreshold(after, this.cfg) };
      stored = { tripId, driverId: trip.driverId, createdAt: new Date().toISOString(), card };
      await this.store.saveCard(stored);
      await this.store.setProfile(trip.driverId, after);
    }
    return { trip_id: tripId, ended: true, card: stored.card };
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
    const [windows, events, stored] = await Promise.all([this.store.getWindows(tripId), this.store.getEvents(tripId), this.store.getCard(tripId)]);
    const card = stored?.card ?? (await this.buildTripCard(trip));
    return { trip_id: tripId, driver_id: trip.driverId, started_at: trip.startedAt, ended_at: trip.endedAt, ...summaryOf(windows, stored?.card), events, card };
  }

  /** Stored card once the trip has ended, otherwise computed live from what has arrived so far. */
  async card(tripId: string): Promise<ReportCard> {
    const trip = await this.mustTrip(tripId);
    return (await this.store.getCard(tripId))?.card ?? (await this.buildTripCard(trip));
  }

  /** The report card as a PNG (live before the trip ends, stored after). */
  async cardImage(tripId: string): Promise<Buffer> {
    const trip = await this.mustTrip(tripId);
    const card = await this.card(tripId);
    return renderReportImage(card, { driverName: trip.driverId, startedAt: trip.startedAt });
  }

  async observations(tripId: string) {
    await this.mustTrip(tripId);
    return this.store.getObservations(tripId);
  }

  async profile(driverId: string) {
    const driver = await this.store.getDriver(driverId);
    if (!driver) throw new HttpError(404, "driver not found");
    const profile = normalizeProfile(driver.profile, this.cfg);
    return {
      driver_id: driverId,
      ...profile,
      scorecard: await this.store.getScorecard(driverId),
      notify_threshold: notifyThreshold(profile, this.cfg),
      default_notify_threshold: this.cfg.tiers.urgent,
      weight_multipliers: { ...defaultMults(), ...driver.weightOverrides },
    };
  }

  private async buildTripCard(trip: TripRow): Promise<ReportCard> {
    const [windows, observations, events, driver, feedback, samples] = await Promise.all([
      this.store.getWindows(trip.id),
      this.store.getObservations(trip.id),
      this.store.getEvents(trip.id),
      this.store.getDriver(trip.driverId),
      this.store.feedbackCounts(trip.id),
      this.store.getGpsSamples(trip.id),
    ]);
    return buildCard(windows, observations, { kidsInCar: trip.kidsInCar, lowExperience: trip.lowExperience }, this.cfg, {
      events,
      baselineHr: trip.baseline?.heartRate ?? null,
      sharingMode: driver?.sharingMode ?? null,
      feedback,
      gps: buildGpsCard(samples, events),
    });
  }

  async driverTrips(driverId: string) {
    const trips = await this.store.listTrips(driverId);
    return Promise.all(
      trips.map(async (t) => {
        const card = (await this.store.getCard(t.id))?.card;
        const s = summaryOf(await this.store.getWindows(t.id), card);
        return {
          trip_id: t.id, started_at: t.startedAt, ended_at: t.endedAt, max_score: s.max_score, grade: s.grade,
          card_score: card?.score ?? null, card_grade: card?.grade ?? null,
          avg_speed_mph: card?.metrics.avg_speed_mph ?? null, top_speed_mph: card?.metrics.max_speed_mph ?? null, attention_score: card?.categories.attention ?? null,
          duration_s: card?.metrics.duration_s ?? null, distance_mi: card?.metrics.distance_mi ?? null,
        };
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

const SEVERITY: Action[] = ["none", "voice_nudge", "voice_warning", "voice_urgent", "ask_permission_to_notify", "notify_contacts"];
const mostSevere = (actions: Action[]): Action => actions.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "none" as Action);

/** From the raw windows while they exist; afterwards from the series and metrics stored on the report card. */
function summaryOf(windows: { ts: string; score: number; tier: Tier }[], card: ReportCard | undefined) {
  if (windows.length || !card) return summarize(windows);
  const [t0, t1, t2, t3] = card.metrics.tier_seconds;
  return { series: card.series, max_score: card.metrics.max_risk, time_in_tier_s: { 0: t0, 1: t1, 2: t2, 3: t3 } as Record<Tier, number>, grade: GRADES[card.metrics.max_tier] };
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
