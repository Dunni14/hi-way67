// Location text for guardian iMessages. Pure, so the format and the omit-cleanly rules are testable.
import { mpsToMph, type LocationFix } from "./types.ts";

export const mapsLink = (fix: Pick<LocationFix, "lat" | "lon">) => `https://maps.apple.com/?ll=${fix.lat.toFixed(4)},${fix.lon.toFixed(4)}`;

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const ago = (s: number) => (s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`);

/**
 * One line for the guardian alert or a "where is he?" answer, or null when there is no fix (so the
 * caller omits the whole thing). `place` is the reverse-geocoded road and city; without it the line is
 * just the link, speed and time. A fix older than `staleS` is labelled with its age.
 */
export function locationLine(fix: LocationFix | null | undefined, place: string | null, now: number, staleS: number): string | null {
  if (!fix) return null;
  const age = Math.max(0, (now - fix.ms) / 1000);
  const parts: string[] = [];
  if (place) parts.push(`near ${place}`);
  if (fix.speed_mps != null) parts.push(fix.speed_mps < 1 ? "stopped" : `${Math.round(mpsToMph(fix.speed_mps))} mph`);
  parts.push(age > staleS ? `last fix ${ago(age)} ago (${clock(fix.ms)})` : `fix at ${clock(fix.ms)}`);
  return `📍 ${parts.join(" · ")}\n${mapsLink(fix)}`;
}

/** Answer to "where did the trip end?": the end position and time, with the link. */
export function endLocationLine(fix: Pick<LocationFix, "lat" | "lon">, place: string | null, endedAtMs: number): string {
  return `Trip ended at ${clock(endedAtMs)}${place ? ` near ${place}` : ""}. ${mapsLink(fix)}`;
}
