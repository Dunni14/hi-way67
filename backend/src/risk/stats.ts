// Driver dashboard: the last N days of a driver's stored report cards, summarized for the app's
// Stats tab (GET /drivers/{id}/stats). Pure; every number comes from report_cards on Tiger Data.
import type { CardRow } from "./store/types.ts";

export type DailyStat = { date: string; label: string; score: number | null; trips: number };
export type Tip = { title: string; detail: string };

export type DriverStats = {
  driver_id: string;
  days: number;
  /** Mean report-card score (0..100, higher is safer); null with no trips. */
  safety_score: number | null;
  trips: number;
  /** Trips that never reached a warning (tier 2+) and had no microsleep. */
  safe_trips: number;
  /** Spoken warnings and urgent alerts the engine fired. */
  risk_events: number;
  daily: DailyStat[];
  attention: { value: "GOOD" | "FAIR" | "POOR" | null; calm_share: number | null };
  eye_tracking: { value: "NORMAL" | "CLOSING" | null; microsleeps: number; longest_closure_s: number };
  avg_speed_mph: number | null;
  distance_mi: number;
  hard_brakes: number;
  yawns: number;
  night_share: number | null;
  tips: Tip[];
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_TRIP_S = 2 * 3600;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Summarize [cards] (any order) over the [days] local days ending today. */
export function driverStats(driverId: string, cards: CardRow[], now = new Date(), days = 7): DriverStats {
  const trips = cards.map((c) => {
    const k = c.card as unknown as {
      score?: number; provisional?: boolean;
      components?: { microsleeps?: number };
      counts?: { hard_brakes?: number };
      metrics?: {
        duration_s?: number; night_trip?: boolean; distance_mi?: number; avg_speed_mph?: number;
        tier_seconds?: number[]; yawns?: number; longest_eye_closure_s?: number; interventions?: Record<string, number>;
      };
    };
    const m = k.metrics ?? {};
    const tiers = [0, 1, 2, 3].map((i) => num(m.tier_seconds?.[i]));
    return {
      at: new Date(c.createdAt),
      score: num(k.score),
      provisional: Boolean(k.provisional),
      duration: num(m.duration_s),
      night: Boolean(m.night_trip),
      distance: num(m.distance_mi),
      speed: num(m.avg_speed_mph),
      tiers,
      microsleeps: num(k.components?.microsleeps),
      brakes: num(k.counts?.hard_brakes),
      yawns: num(m.yawns),
      longest: num(m.longest_eye_closure_s),
      alerts: num(m.interventions?.voice_warning) + num(m.interventions?.voice_urgent),
    };
  });

  const scored = trips.filter((t) => !t.provisional);
  const safetyScore = mean((scored.length ? scored : trips).map((t) => t.score));

  // One bar per local day, oldest first, ending today.
  const daily: DailyStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDate(d);
    const that = trips.filter((t) => localDate(t.at) === key);
    const thatScored = that.filter((t) => !t.provisional); // same rule as the headline score
    daily.push({ date: key, label: DAY_LABELS[d.getDay()]!, score: mean((thatScored.length ? thatScored : that).map((t) => t.score)), trips: that.length });
  }

  const tierTotals = [0, 1, 2, 3].map((i) => trips.reduce((s, t) => s + t.tiers[i]!, 0));
  const allTime = tierTotals.reduce((a, b) => a + b, 0);
  const calmShare = allTime > 0 ? tierTotals[0]! / allTime : null;
  const microsleeps = trips.reduce((s, t) => s + t.microsleeps, 0);
  const longest = trips.reduce((s, t) => Math.max(s, t.longest), 0);
  const driven = trips.reduce((s, t) => s + t.duration, 0);
  const hardBrakes = trips.reduce((s, t) => s + t.brakes, 0);
  const yawns = trips.reduce((s, t) => s + t.yawns, 0);
  const nightShare = trips.length ? trips.filter((t) => t.night).length / trips.length : null;

  const tips: Tip[] = [];
  const longTrips = trips.filter((t) => t.duration >= LONG_TRIP_S).length;
  if (longTrips) tips.push({ title: "Take regular breaks", detail: `You drove 2+ hours without a break on ${plural(longTrips, "trip")}.` });
  if (microsleeps) tips.push({ title: "Rest before you drive", detail: `Your eyes closed too long ${plural(microsleeps, "time")} this week.` });
  if (yawns >= 5) tips.push({ title: "Watch for tiredness", detail: `${yawns} yawns this week. A short nap before long drives helps.` });
  if (hardBrakes >= 3) tips.push({ title: "Leave more following distance", detail: `${plural(hardBrakes, "hard brake")} this week.` });
  if (nightShare != null && nightShare >= 0.5 && trips.length >= 2) {
    tips.push({ title: "Drive in daylight when you can", detail: `${Math.round(nightShare * 100)}% of your trips were at night.` });
  }
  if (!tips.length && trips.length) tips.push({ title: "Keep it up", detail: "No risky patterns this week." });

  return {
    driver_id: driverId,
    days,
    safety_score: safetyScore == null ? null : Math.round(safetyScore * 10) / 10,
    trips: trips.length,
    safe_trips: trips.filter((t) => t.tiers[2] === 0 && t.tiers[3] === 0 && t.microsleeps === 0).length,
    risk_events: trips.reduce((s, t) => s + t.alerts, 0),
    daily,
    attention: { value: calmShare == null ? null : calmShare >= 0.9 ? "GOOD" : calmShare >= 0.7 ? "FAIR" : "POOR", calm_share: calmShare },
    eye_tracking: { value: trips.length ? (microsleeps > 0 ? "CLOSING" : "NORMAL") : null, microsleeps, longest_closure_s: longest },
    avg_speed_mph: driven > 0 ? Math.round((trips.reduce((s, t) => s + t.speed * t.duration, 0) / driven) * 10) / 10 : null,
    distance_mi: Math.round(trips.reduce((s, t) => s + t.distance, 0) * 10) / 10,
    hard_brakes: hardBrakes,
    yawns,
    night_share: nightShare,
    tips: tips.slice(0, 3),
  };
}
