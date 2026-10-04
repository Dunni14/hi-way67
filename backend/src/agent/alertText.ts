// Text of the tier 3 guardian alert. Pure so the "link when there is a fix, nothing when there is not" rule is testable.
import type { Dominant } from "../ws/protocol.ts";

/** `location` is the line from trip.locationText(): link, speed, fix time, road and city. Null leaves it out cleanly. */
export function guardianAlertText(driver: string, dominant: Dominant, location: string | null): string {
  return `⚠️ ${driver} is at high risk (${dominant}). I've told them to pull over.${location ? `\n${location}` : ""}`;
}
