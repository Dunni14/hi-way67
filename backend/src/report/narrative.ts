// A brief, plain-language account of the trip for friends and family. Deterministic (no LLM), so it is
// instant and the arrival report never stalls. Names the driver, never a location, makes no medical claims.
import type { Category, ReportCard } from "../risk/card.ts";

const OPENER = {
  A: (n: string) => `${n} had a smooth, attentive drive.`,
  B: (n: string) => `${n} drove well overall.`,
  C: (n: string) => `${n}'s drive had a few rough patches.`,
  D: (n: string) => `${n}'s drive had several risky moments.`,
  F: (n: string) => `${n}'s drive was risky.`,
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutes = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** What stood out for one weak category, as a short clause. */
function standout(c: Category, card: ReportCard): string {
  const m = card.metrics;
  switch (c) {
    case "speed":
      return m.over_limit_s > 0 ? `was over the limit for ${minutes(m.over_limit_s)} (up to ${Math.round(m.max_over_limit_mph)} mph over)` : "ran above the limit";
    case "attention":
      return m.phone_s > 0 ? `used a phone for ${minutes(m.phone_s)}` : `looked away from the road for ${minutes(m.gaze_off_road_s)}`;
    case "smoothness":
      return `had ${plural(card.counts.hard_brakes, "hard brake")} and ${plural(card.counts.swerves, "swerve")}`;
    case "alertness":
      return m.yawns > 0 ? `showed signs of drowsiness (${plural(m.yawns, "yawn")})` : "showed signs of drowsiness";
    case "composure":
      return "looked stressed at times";
  }
}

export function tripNarrative(card: ReportCard, driverName: string): string {
  const m = card.metrics;
  const parts = [OPENER[card.grade](driverName)];
  const trip = `${minutes(m.duration_s)}, ${m.distance_mi.toFixed(1)} mi`;

  // The weakest categories under 85, worst first, at most two.
  const weak = (Object.entries(card.categories) as [Category, number][]).filter(([, v]) => v < 85).sort((a, b) => a[1] - b[1]).slice(0, 2);
  if (weak.length) parts.push(`${driverName} ${weak.map(([c]) => standout(c, card)).join(" and ")}.`);
  else parts.push(`No warnings were needed over ${trip}.`);

  const warnings = m.interventions.voice_nudge + m.interventions.voice_warning + m.interventions.voice_urgent;
  if (m.interventions.notify_contacts > 0) parts.push(m.overrides.microsleep ? "A microsleep triggered an urgent alert and contacts were told." : "Contacts were told during the drive.");
  else if (warnings > 0) parts.push(`${plural(warnings, "voice warning")} played.`);
  else if (weak.length) parts.push("No alerts were needed.");

  if (card.provisional) parts.push("It was a short drive, so the score is provisional.");
  return parts.join(" ");
}
