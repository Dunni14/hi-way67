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
  if (!trip.active) return [`${d} is not on a drive right now.`];
  if (trip.sharingMode === "never") return [`${d} has trip sharing turned off.`];

  const highRecent = now - trip.lastHighAlertAt < HIGH_ALERT_SHARE_MS;
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
    const link = trip.mapsLink();
    if (link) facts.push(`Location: ${link}`);
  } else {
    facts.push(`(The asker is a friend, not a guardian: do not share location.)`);
  }
  return facts;
}

const ACTION_LABELS: Record<string, string> = {
  calm_checkin: "a calm check-in",
  start_conversation: "having a conversation",
  suggest_music: "upbeat music",
  suggest_rest_stop: "a rest stop suggestion",
  calm_slowdown: "a calm reminder to ease off",
  breathing_prompt: "guided breathing",
  report_card_reminder: "a report-card reminder",
  firm_warning: "a firm warning",
  family_voice_warning: "a warning in a family member's voice",
};

export type PolicySummary = { actions: { action: string; updates: number; mean_reward: number | null }[] };

/** What the adaptive-recommendation layer has learned works best for this driver, as a fact for the LLM. Empty until something has clearly worked. */
export function policyFacts(driver: string, policy: PolicySummary): string[] {
  const best = policy.actions
    .filter((a) => a.updates >= 2 && a.mean_reward != null && a.mean_reward > 0 && ACTION_LABELS[a.action])
    .sort((a, b) => b.mean_reward! - a.mean_reward!)[0];
  return best ? [`So far, ${ACTION_LABELS[best.action]} has worked best for keeping ${driver} safe when they're warned.`] : [];
}

export async function answerQuestion(question: string, askerName: string, role: Role, extraFacts: string[] = []): Promise<string> {
  const facts = [...tripFacts(role), ...extraFacts];
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
