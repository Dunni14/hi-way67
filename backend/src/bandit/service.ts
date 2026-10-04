// Adaptive recommendations: picks which intervention a driver hears within the tier
// the decision tree already chose, and learns from what happened 120 s later.
// The tree, tiers, thresholds and cooldowns are not touched; tier 3 is never learned.
// Selection/update math is in linucb.ts and reward.ts (pure); this file only wires them to the store.
import { banditConfig, type BanditConfig } from "./config.ts";
import { choose, initModel, update } from "./linucb.ts";
import { allowedActions, buildContext, computeReward, targetLevel, type Dominant } from "./reward.ts";
import type { BanditStore } from "./store.ts";
import type { TripRow, WindowRow } from "../risk/store/types.ts";
import type { Evaluation } from "../risk/types.ts";

export type Intervention = { id: string; event_ts: string; learned: boolean };

/** Whether this driver has a family voice recorded. Default "no"; `index.ts` passes `ELEVENLABS_FAMILY_VOICE_ID` being set. */
export type FamilyVoiceLookup = (driverId: string) => boolean | Promise<boolean>;

export class BanditService {
  /** Model updates are read-modify-write; trips of one driver can settle at the same time, so serialize per driver (this process only). */
  private locks = new Map<string, Promise<unknown>>();

  private withDriverLock<T>(driverId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(driverId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(driverId, next);
    void next.finally(() => this.locks.get(driverId) === next && this.locks.delete(driverId)).catch(() => {});
    return next;
  }

  constructor(
    private store: BanditStore,
    private cfg: BanditConfig = banditConfig,
    private hasFamilyVoice: FamilyVoiceLookup = () => false,
  ) {}

  private isDefault(action: string) {
    const d = this.cfg.defaults;
    return [d[1].drowsy, d[1].reckless, d[2].drowsy, d[2].reckless].includes(action);
  }

  /** Pick an intervention for a tier 1 or 2 voice action and record it. Returns null for any other tier. */
  async select(p: { trip: TripRow; ev: Evaluation; ts: string }): Promise<Intervention | null> {
    const { trip, ev, ts } = p;
    const tier = ev.tier;
    if (tier !== 1 && tier !== 2) return null;
    if (!ev.actions.some((a) => a === "voice_nudge" || a === "voice_warning")) return null;

    const dominant: Dominant = ev.dominant;
    const allowed = allowedActions(this.cfg, tier, dominant, await this.hasFamilyVoice(trip.driverId));
    const def = this.cfg.defaults[tier][dominant];
    const x = buildContext(
      {
        levels: ev.levels,
        tripMinutes: (Date.parse(ts) - Date.parse(trip.startedAt)) / 60_000,
        ts: new Date(ts),
        kidsInCar: trip.kidsInCar,
        interventionsThisTrip: await this.store.countEvents(trip.id),
      },
      this.cfg,
    );

    const stored = await this.store.getModels(trip.driverId, allowed);
    const models = Object.fromEntries(allowed.map((a) => [a, stored[a] ?? initModel(x.length, this.isDefault(a) ? this.cfg.defaultBias : 0)]));
    const { action, scores } = choose(models, allowed, x, this.cfg.alpha, def);
    const learned = action !== def || allowed.some((a) => models[a]!.updates > 0);

    await this.store.addEvent({ ts, driverId: trip.driverId, tripId: trip.id, tier, dominant, action, context: x, scores });
    return { id: action, event_ts: ts, learned };
  }

  /**
   * Settle every intervention of this trip whose 120 s are over, from the windows that arrived
   * in between. `windows` is only called when something is due. No reward (and no update) when
   * the face was mostly hidden or there is nothing to compare.
   */
  async processRewards(p: { trip: TripRow; nowTs: string; windows: () => Promise<WindowRow[]> }) {
    const { trip, nowTs } = p;
    const pending = await this.store.pendingEvents(trip.id, nowTs, this.cfg.rewardDelayS);
    if (!pending.length) return;
    const all = await p.windows();

    for (const ev of pending) {
      const startMs = Date.parse(ev.ts);
      const endMs = startMs + this.cfg.rewardDelayS * 1000;
      const period = all.filter((w) => Date.parse(w.ts) > startMs && Date.parse(w.ts) <= endMs);
      const hidden = period.filter((w) => w.raw.face_visible === false || w.result.degraded).length;
      const endedEarly = trip.endedAt != null && Date.parse(trip.endedAt) < endMs;

      let reward: number | null = null;
      if (!endedEarly && period.length && hidden / period.length <= this.cfg.faceHiddenMajority) {
        const target = (w: WindowRow) => targetLevel(ev.dominant, w.result.levels);
        reward = computeReward(
          {
            before: all.filter((w) => Date.parse(w.ts) < startMs).slice(-this.cfg.beforeWindows).map(target),
            after: period.slice(-this.cfg.afterWindows).map(target),
            stoppedAfterDrowsy: ev.dominant === "drowsy" && this.stoppedFor(period),
            falseAlarm: ev.falseAlarm,
            tierWentUp: period.some((w) => w.tier > ev.tier),
          },
          this.cfg,
        );
      }
      if (reward != null) {
        const r = reward;
        await this.withDriverLock(ev.driverId, async () => {
          const m = (await this.store.getModels(ev.driverId, [ev.action]))[ev.action] ?? initModel(ev.context.length, this.isDefault(ev.action) ? this.cfg.defaultBias : 0);
          await this.store.saveModel(ev.driverId, ev.action, update(m, ev.context, r));
        });
      }
      await this.store.resolveEvent(trip.id, ev.ts, reward, nowTs);
    }
  }

  /** Speed 0 for `stopS` seconds or more, as consecutive windows. */
  private stoppedFor(period: WindowRow[]): boolean {
    let runStart: number | null = null;
    for (const w of period) {
      const t = Date.parse(w.ts);
      if (w.raw.speed_mph !== 0) {
        runStart = null;
        continue;
      }
      runStart ??= t;
      if ((t - runStart) / 1000 + this.cfg.windowS >= this.cfg.stopS) return true;
    }
    return false;
  }

  markFalseAlarm(tripId: string, windowTs: string) {
    return this.store.markFalseAlarm(tripId, windowTs, this.cfg.rewardDelayS);
  }

  /** Per action: how many times it has been learned from and its mean reward. */
  async policy(driverId: string) {
    const rows = new Map((await this.store.policy(driverId)).map((r) => [r.action, r]));
    return {
      driver_id: driverId,
      actions: Object.keys(this.cfg.actions).map((id) => ({ action: id, updates: rows.get(id)?.updates ?? 0, mean_reward: rows.get(id)?.meanReward ?? null })),
    };
  }
}
