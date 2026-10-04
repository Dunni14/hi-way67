// Wires phone events and chat messages together. This is where the README's
// decision-tree outputs (§4) turn into voice (§5) and chat actions (§6).
import { trip } from "./trip/state.ts";
import type { TripStore } from "./trip/store.ts";
import type { PhoneMsg, Tier, Dominant } from "./ws/protocol.ts";
import { sendToPhone } from "./ws/server.ts";
import { driverQueue } from "./voice/driverQueue.ts";
import { ackLine, alertLine, ASKS_REST_STOP, gradeOf, interventionLine, messageLine, permissionLine, roastLine } from "./voice/lines.ts";
import { post, dm, type Inbound } from "./agent/spectrum.ts";
import { classify, shortenForSpeech } from "./agent/classifier.ts";
import { answerQuestion } from "./agent/answer.ts";
import { parseDriverUtterance } from "./agent/driverIntent.ts";
import { roast } from "./agent/roast.ts";
import { allContacts } from "./agent/contacts.ts";
import type { Evaluation } from "./risk/types.ts";
import type { Intervention } from "./bandit/service.ts";
import { config } from "./config.ts";

const LISTEN_MS = 5000;

export function createOrchestrator(store: TripStore) {
  const d = () => trip.driverName;
  let pendingPermission: { dominant: Dominant } | null = null;
  // Extra facts for chat answers (what the bandit has learned); set once the risk service exists.
  let insights: (() => Promise<string[]>) | null = null;
  const setInsights = (fn: () => Promise<string[]>) => {
    insights = fn;
  };

  // ---- phone -> backend ----------------------------------------------------

  async function onPhone(msg: PhoneMsg) {
    switch (msg.type) {
      case "hello":
        if (msg.driverName) trip.driverName = msg.driverName;
        trip.sharingMode = msg.sharingMode;
        trip.kidsInCar = msg.kidsInCar;
        console.log(`[phone] hello: ${trip.driverName}, sharing=${trip.sharingMode}, kids=${trip.kidsInCar}`);
        return;

      case "settings":
        if (msg.sharingMode) trip.sharingMode = msg.sharingMode;
        if (msg.kidsInCar !== undefined) trip.kidsInCar = msg.kidsInCar;
        return;

      case "trip_start":
        return onTripStart();

      case "trip_end":
        return onTripEnd();

      case "risk_window": {
        if (!trip.active) onTripStart();
        const { type: _, features, ...w } = msg;
        trip.addWindow(w);
        if (w.events.includes("hard_brake")) driverQueue.pause();
        await store.saveWindow({ tripId: trip.tripId!, ...w, features }).catch((err) => console.error("[store] saveWindow:", err));
        return;
      }

      case "alert":
        return onAlert(msg.tier, msg.dominant, msg.R);

      case "utterance":
        return onUtterance(msg.text, msg.context);

      case "speak_done":
        driverQueue.done(msg.id);
        return;
    }
  }

  async function onTripStart() {
    if (trip.active) return;
    trip.start();
    await store.startTrip({ tripId: trip.tripId!, driverName: d(), startedAt: trip.startedAt, maxR: 0, alerts: 0 });
    console.log(`[trip] started ${trip.tripId}`);
    if (trip.sharingMode !== "always") return;

    let note = `🚗 ${d()} just started driving.`;
    if (isNight(new Date())) {
      const weekAgo = Date.now() - 7 * 24 * 3600_000;
      const nightTrips = (await store.getRecentTrips(d(), weekAgo)).filter((t) => isNight(new Date(t.startedAt)));
      if (nightTrips.length >= 2) note += ` Heads up: that's the ${ordinal(nightTrips.length)} late-night drive this week.`;
    }
    await post(note).catch(logPostError);
  }

  async function onTripEnd() {
    if (!trip.active) return;
    const minutes = trip.drivingMinutes();
    const summary = `🏁 ${d()} arrived safely. ${minutes} min drive, ${trip.alertCount} warning${trip.alertCount === 1 ? "" : "s"}, peak risk ${Math.round(trip.maxR)}/100.`;
    await store.endTrip(trip.tripId!, { endedAt: Date.now(), maxR: trip.maxR, alerts: trip.alertCount });
    trip.end();
    roast.resolve();
    driverQueue.clear();
    console.log(`[trip] ended: ${summary}`);

    if (trip.sharingMode !== "never") await post(summary).catch(logPostError);
    // Contacts who asked "let me know when he arrives" get a direct ping too.
    for (const c of allContacts()) {
      if ((await store.getContactPrefs(c.handle)).notifyOnArrival) {
        await dm(c.handle, `You asked me to tell you: ${d()} arrived safely.`);
        await store.setContactPrefs(c.handle, { notifyOnArrival: false });
      }
    }
  }

  /**
   * Risk engine (REST API) -> existing voice / iMessage path. The engine has
   * already applied hold, cooldown and the kids bump, so this carries out what
   * it asked for: a voice line (the bandit's intervention when there is one)
   * and/or the contact notification (`notify_contacts`, limited by the engine
   * to once per 10 min, or the permission question when sharing is off).
   * No bump again here.
   */
  async function onRiskEvaluation(ev: Evaluation, intervention?: Intervention) {
    if (ev.tier === 0) return;
    const voice = ev.actions.some((a) => a.startsWith("voice_"));
    const notify = ev.actions.includes("notify_contacts") ? "notify" : ev.actions.includes("ask_permission_to_notify") ? "ask" : "none";
    if (!voice && notify === "none") return;
    const tier: Tier = ev.tier === 3 ? 85 : ev.tier === 2 ? 70 : 40;
    await onAlert(tier, ev.dominant, ev.score, { bumped: true, voice, notify, intervention: intervention?.id });
  }

  type AlertOpts = {
    bumped?: boolean;
    /** Speak the alert line. Default true. */
    voice?: boolean;
    /** Tier 3 only. Default follows the phone's sharing mode (legacy phone path). */
    notify?: "notify" | "ask" | "none";
    /** Bandit intervention id: replaces the generic line for tier 1/2. */
    intervention?: string;
  };

  async function onAlert(phoneTier: Tier, dominant: Dominant, R: number, opts: AlertOpts = {}) {
    // Kids in the car bump the 70 tier up a level (README §4). Alerts from the
    // risk engine arrive already bumped.
    const tier: Tier = !opts.bumped && phoneTier === 70 && trip.kidsInCar ? 85 : phoneTier;
    const voice = opts.voice ?? true;
    if (voice) trip.recordAlert(tier, dominant, R);
    console.log(`[alert] tier=${tier} (${dominant}) R=${Math.round(R)}${opts.intervention ? ` intervention=${opts.intervention}` : ""}`);

    if (tier < 85) {
      // Mid-tier: voice only, never the group chat.
      if (!voice) return;
      const id = opts.intervention;
      const line = (id && interventionLine(id, { grade: gradeOf(trip.maxR) })) || alertLine(tier, dominant);
      driverQueue.enqueue({
        text: line,
        tier,
        context: "checkin",
        // Only the rest-stop offer waits for a yes/no; other replies would be relayed to the group chat.
        listenAfterMs: id && !ASKS_REST_STOP.has(id) ? 0 : LISTEN_MS,
        priority: true,
        voiceId: id === "family_voice_warning" ? config.elevenLabs.familyVoiceId || undefined : undefined,
      });
      return;
    }

    if (voice) driverQueue.enqueue({ text: alertLine(85, dominant), tier: 85, context: "checkin", listenAfterMs: 0, priority: true });
    const notify = opts.notify ?? (trip.sharingMode === "never" ? "ask" : "notify");
    if (notify === "ask") {
      pendingPermission = { dominant };
      driverQueue.enqueue({ text: permissionLine(), tier: 85, context: "permission", listenAfterMs: LISTEN_MS });
    } else if (notify === "notify") {
      await escalate(dominant);
    }
  }

  async function escalate(dominant: Dominant) {
    trip.lastHighAlertAt = Date.now();
    const link = trip.mapsLink();
    await post(
      `⚠️ ${d()} is at high risk (${dominant}). I've told them to pull over.${link ? ` Location: ${link}` : ""}`,
      "guardian",
    ).catch(logPostError);
    if (dominant === "drowsy" && !roast.active) {
      roast.start();
      await post(roast.callText()).catch(logPostError);
    }
  }

  async function onUtterance(text: string, context: string) {
    const intent = parseDriverUtterance(text, context);
    console.log(`[driver] "${text}" (${context}) -> ${intent.kind}`);

    if (pendingPermission && (context === "permission" || intent.kind === "yes" || intent.kind === "no")) {
      const { dominant } = pendingPermission;
      pendingPermission = null;
      if (intent.kind === "yes") {
        driverQueue.enqueue({ text: ackLine("notified"), context: "info", priority: true });
        await escalate(dominant);
      } else {
        driverQueue.enqueue({ text: ackLine("not_notified"), context: "info", priority: true });
      }
      return;
    }

    switch (intent.kind) {
      case "dismiss":
        sendToPhone({ type: "dismissed" });
        driverQueue.enqueue({ text: ackLine("dismissed"), context: "info" });
        if (roast.active) await resolveRoast(text);
        return;
      case "yes":
        if (context === "checkin") {
          sendToPhone({ type: "navigate", query: "rest stop" });
          driverQueue.enqueue({ text: ackLine("navigating"), context: "info", priority: true });
          return;
        }
        if (roast.heardOne) await resolveRoast(text);
        return;
      case "reply":
        if (roast.heardOne) return resolveRoast(text);
        await post(`🗣️ ${d()} says: "${text}"`).catch(logPostError);
        driverQueue.enqueue({ text: ackLine("sent"), context: "info" });
        return;
      case "no":
      case "unknown":
        if (roast.heardOne) await resolveRoast(text);
        return;
    }
  }

  async function resolveRoast(driverText: string) {
    roast.resolve();
    await post(`🗣️ ${d()} says: "${driverText}"\n✅ ${d()} is talking back, so they're awake. Thanks for the roasts!`).catch(logPostError);
  }

  // ---- chat -> backend -----------------------------------------------------

  async function onChat({ contact, message, space, text, isGroup }: Inbound) {
    const c = await classify({ text, senderName: contact.name, isGroup, roastActive: roast.active });
    console.log(`[chat] ${contact.name} (${contact.role}): "${text}" -> ${c.kind}`);

    switch (c.kind) {
      case "chatter":
        return;

      case "question":
        // Learned "what works for the driver" is shared with guardians only, and never when sharing is off.
        const extra = contact.role === "guardian" && trip.sharingMode !== "never" && insights ? await insights().catch(() => []) : [];
        await space.responding(async () => message.reply(await answerQuestion(text, contact.name, contact.role, extra)));
        return;

      case "arrival_pref":
        await store.setContactPrefs(contact.handle, { notifyOnArrival: true });
        await message.reply(`Will do. I'll text you when ${d()} arrives.`);
        return;

      case "to_driver": {
        if (!trip.active) {
          await message.reply(`${d()} isn't driving right now, so I'll leave it here for them.`);
          return;
        }
        const line = await shortenForSpeech(c.text);
        driverQueue.enqueue({ text: messageLine(contact.name, line), context: "after_message", listenAfterMs: LISTEN_MS });
        await message.react("👍").catch(() => message.reply(`Got it, I'll tell ${d()}.`));
        return;
      }

      case "roast_reply": {
        const line = await shortenForSpeech(c.text);
        // Roasts jump the queue: a driver who answers back is proving they're awake.
        driverQueue.enqueue({ text: roastLine(contact.name, line), context: "roast", listenAfterMs: LISTEN_MS, priority: true });
        roast.played();
        await message.react("😂").catch(() => {});
        return;
      }
    }
  }

  return { onPhone, onChat, onRiskEvaluation, setInsights };
}

function isNight(date: Date) {
  const h = date.getHours();
  return h >= 22 || h < 5;
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

function logPostError(err: unknown) {
  console.error("[spectrum] post failed:", err);
}
