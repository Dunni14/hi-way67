// Answers contacts' questions from live trip state. Facts given to the LLM
// are filtered by role and sharing mode first, so it can't leak what it
// never sees.
import { chat } from "../llm/openrouter.ts";
import { config } from "../config.ts";
import { trip } from "../trip/state.ts";
import type { Role } from "./contacts.ts";

const HIGH_ALERT_SHARE_MS = 15 * 60_000;

export function tripFacts(role: Role, now = Date.now()): string[] {
  const d = trip.driverName;
  const highRecent = now - trip.lastHighAlertAt < HIGH_ALERT_SHARE_MS;
  if (!trip.active) {
    // After the trip the guardians can still ask where it ended, under the same sharing rules.
    const facts = [`${d} is not on a drive right now.`];
    const end = trip.endLocationText();
    const mayShare = trip.sharingMode === "always" || (trip.sharingMode === "high_only" && highRecent);
    if (role === "guardian" && end && mayShare) facts.push(end);
    return facts;
  }
  if (trip.sharingMode === "never") return [`${d} has trip sharing turned off.`];

  if (trip.sharingMode === "high_only" && !highRecent) {
    return [`${d} is driving.`, `${d} only shares details when something is wrong, and everything looks fine.`];
  }

  const w = trip.latest;
  const facts = [`${d} has been driving for ${trip.drivingMinutes(now)} minutes.`];
  if (w) facts.push(trip.isStopped(now) ? `${d} is currently stopped.` : `Current speed: about ${Math.round(w.speed)} mph.`);
  if (w) facts.push(`Current alertness risk: ${Math.round(w.R)} out of 100 (${w.R < 40 ? "fine" : w.R < 70 ? "a bit tired/risky" : "high"}).`);
  const yawns = trip.countEvents("yawn", 10 * 60_000, now);
  if (yawns) facts.push(`${yawns} yawns in the last 10 minutes.`);
  if (trip.lastAlert) facts.push(`Last warning: ${Math.round((now - trip.lastAlert.at) / 60_000)} minutes ago (${trip.lastAlert.dominant}).`);
  if (role === "guardian") {
    const loc = trip.locationText(now);
    if (loc) facts.push(`Location: ${loc.replace("\n", " ")}`);
  } else {
    facts.push(`(The asker is a friend, not a guardian: do not share location.)`);
  }
  return facts;
}

export async function answerQuestion(question: string, askerName: string, role: Role): Promise<string> {
  if (role === "guardian") await trip.resolvePlace(); // road and city for the location fact; best effort
  const facts = tripFacts(role);
  try {
    return await chat({
      model: config.openRouter.models.answer,
      system: `You are ${config.driverName}'s driving assistant in an iMessage family chat. Answer ${askerName}'s question in 1-2 short, friendly texting sentences using ONLY these facts. If the facts don't cover it, say you don't know. Include the location link only if it's in the facts and relevant.\nFacts:\n- ${facts.join("\n- ")}`,
      user: question,
      maxTokens: 120,
    });
  } catch (err) {
    console.warn("[answer] LLM failed, sending raw facts:", (err as Error).message);
    return facts.filter((f) => !f.startsWith("(")).join(" ");
  }
}
