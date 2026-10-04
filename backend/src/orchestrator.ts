// Wires phone events and chat messages together. This is where the README's
// decision-tree outputs (§4) turn into voice (§5) and chat actions (§6).
import { trip } from "./trip/state.ts";
import type { TripStore } from "./trip/store.ts";
import type { PhoneMsg, Tier, Dominant } from "./ws/protocol.ts";
import { sendToPhone } from "./ws/server.ts";
import { driverQueue } from "./voice/driverQueue.ts";
import { ackLine, alertLine, ASKS_REST_STOP, gradeOf, interventionLine, messageLine, permissionLine, roastLine, speedingNudge } from "./voice/lines.ts";
import { post, dm, type Inbound } from "./agent/spectrum.ts";
import { classify, shortenForSpeech } from "./agent/classifier.ts";
import { answerQuestion } from "./agent/answer.ts";
import { parseDriverUtterance } from "./agent/driverIntent.ts";
import { roast } from "./agent/roast.ts";
import { allContacts } from "./agent/contacts.ts";
import type { Evaluation } from "./risk/types.ts";
import type { EvaluationExtra, RiskService } from "./risk/service.ts";
import { RestStopFinder, milesAhead } from "./gps/restStop.ts";
import { riskConfig } from "./risk/config.ts";
import type { LocationFix } from "./gps/types.ts";
import { config } from "./config.ts";

const LISTEN_MS = 5000;

export function createOrchestrator(store: TripStore, restStops = new RestStopFinder(riskConfig)) {
  const d = () => trip.driverName;
  let pendingPermission: { dominant: Dominant } | null = null;
  // Extra facts for chat answers (what the bandit has learned); set once the risk service exists.
  let insights: (() => Promise<string[]>) | null = null;
  const setInsights = (fn: () => Promise<string[]>) => {
    insights = fn;
  };

  // The risk engine scores every phone window and decides every alert (via onRiskEvaluation).
  let risk: RiskService | null = null;
  const setRisk = (r: RiskService) => {
    risk = r;
  };
  // Engine trip for the current phone trip (created on trip_start), and the last window it scored.
  let engineTrip: Promise<string | null> | null = null;
  let lastWindowTs: string | null = null;
  let windowsScored = 0;

  // ---- phone -> backend ----------------------------------------------------

  async function onPhone(msg: PhoneMsg) {
    switch (msg.type) {
      case "hello":
        if (msg.driverName) trip.driverName = msg.driverName;
        trip.sharingMode = msg.sharingMode;
        trip.kidsInCar = msg.kidsInCar;
        trip.shareLocation = msg.shareLocation;
        console.log(`[phone] hello: ${trip.driverName}, sharing=${trip.sharingMode}, kids=${trip.kidsInCar}`);
        return;

      case "settings":
        if (msg.sharingMode) trip.sharingMode = msg.sharingMode;
        if (msg.kidsInCar !== undefined) trip.kidsInCar = msg.kidsInCar;
        if (msg.shareLocation !== undefined) trip.shareLocation = msg.shareLocation;
        return;

      case "trip_start":
        return onTripStart();

      case "trip_end":
        return onTripEnd();

      case "risk_window":
        return onRiskWindow(msg);

      case "utterance":
        return onUtterance(msg.text, msg.context);

      case "speak_done":
        driverQueue.done(msg.id);
        return;
    }
  }

  /** Score one phone window in the engine; its hook (onRiskEvaluation) handles voice and contacts. */
  async function onRiskWindow(msg: Extract<PhoneMsg, { type: "risk_window" }>) {
    if (!trip.active) await onTripStart();
    if (msg.events.includes("hard_brake")) driverQueue.pause();
    const tripId = await engineTrip;
    if (!risk || !tripId) {
      console.warn("[risk] no risk engine; window not scored");
      return;
    }
    const ts = new Date(msg.ts).toISOString();
    let ev: Evaluation;
    try {
      ev = await risk.ingestWindow(tripId, { ...msg.signals, speed_mph: msg.signals.speed_mph ?? msg.speed, ts });
    } catch (err) {
      console.error("[risk] window rejected:", (err as Error).message);
      return;
    }
    lastWindowTs = ts;
    windowsScored++;
    const { drowsy, ...rest } = ev.levels;
    // Live view for chat answers and the roast text, on the 0..100 scale.
    trip.addWindow({
      ts: msg.ts, R: ev.score, drowsy: drowsy * 100, reckless: Math.max(...Object.values(rest)) * 100,
      speed: msg.speed, lat: msg.lat, lon: msg.lon, events: msg.events,
    });
    sendToPhone({
      type: "evaluation", ts: msg.ts, score: ev.score, tier: ev.tier, dominant: ev.dominant, levels: ev.levels,
      override: ev.override, degraded: ev.degraded, actions: ev.actions,
      calibrating: windowsScored <= riskConfig.baselineWindows,
    });
  }

  async function onTripStart() {
    if (trip.active) return;
    trip.start();
    lastWindowTs = null;
    windowsScored = 0;
    engineTrip = risk
      ? risk
          .startTrip({ driver_id: d(), kids_in_car: trip.kidsInCar, low_experience: false, sharing_mode: trip.sharingMode })
          .then((r) => r.trip_id)
          .catch((err) => (console.error("[risk] startTrip:", err), null))
      : Promise.resolve(null);
    await store.startTrip({ tripId: trip.tripId!, driverName: d(), startedAt: trip.startedAt, maxR: 0, alerts: 0 });
    console.log(`[trip] started ${trip.tripId} (engine trip ${await engineTrip})`);
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
    const tripId = await engineTrip;
    if (risk && tripId) await risk.endTrip(tripId).catch((err) => console.error("[risk] endTrip:", err));
    engineTrip = null;
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
  async function onRiskEvaluation(ev: Evaluation, extra?: EvaluationExtra) {
    if (extra) {
      trip.shareLocation = extra.shareLocation;
      if (extra.location) trip.setFix(extra.location);
      // GPS decided the trip started moving or stopped for good.
      if (extra.lifecycle.includes("started")) await onTripStart();
      if (extra.lifecycle.includes("ended")) await onTripEnd();
    }
    const fix = extra?.location ?? trip.lastFix;
    // Warm the rest stop cache while the driver is only mildly drowsy, so tier 2 and 3 can name a stop without waiting.
    if (ev.dominant === "drowsy" && ev.tier >= 1 && fix) void restStops.next(fix);

    if (ev.tier === 0) return;
    const voice = ev.actions.some((a) => a.startsWith("voice_"));
    const notify = ev.actions.includes("notify_contacts") ? "notify" : ev.actions.includes("ask_permission_to_notify") ? "ask" : "none";
    if (!voice && notify === "none") return;
    const tier: Tier = ev.tier === 3 ? 85 : ev.tier === 2 ? 70 : 40;
    await onAlert(tier, ev.dominant, ev.score, {
      bumped: true,
      voice,
      notify,
      intervention: extra?.intervention?.id,
      speedingLine: speedingNudge(ev),
      restMiles: voice && ev.dominant === "drowsy" && tier >= 70 ? await restMilesAhead(fix) : null,
    });
  }

  /** Miles to the next stop ahead, from the cache or a short wait; null when unknown. The alert never waits long for it. */
  async function restMilesAhead(fix: LocationFix | null): Promise<number | null> {
    if (!fix) return null;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), riskConfig.gps.restStop.timeoutMs / 2)));
    const stop = await Promise.race([restStops.next(fix), limit]).finally(() => clearTimeout(timer));
    return stop ? milesAhead(stop) : null;
  }

  type AlertOpts = {
    bumped?: boolean;
    /** Speak the alert line. Default true. */
    voice?: boolean;
    /** Tier 3 only. Default follows the phone's sharing mode (legacy phone path). */
    notify?: "notify" | "ask" | "none";
    /** Bandit intervention id: replaces the generic line for tier 1/2. */
    intervention?: string;
    /** GPS speeding line for a tier 1 reckless nudge (voice/lines.ts speedingNudge). */
    speedingLine?: string | null;
    /** Miles to the next rest stop for a drowsy tier 2/3 line. */
    restMiles?: number | null;
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
      const line =
        (id && interventionLine(id, { grade: gradeOf(trip.maxR) })) ||
        (tier === 40 && dominant === "reckless" && opts.speedingLine) ||
        alertLine(tier, dominant, { restMiles: opts.restMiles });
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

    if (voice) driverQueue.enqueue({ text: alertLine(85, dominant, { restMiles: opts.restMiles }), tier: 85, context: "checkin", listenAfterMs: 0, priority: true });
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
    // The alert goes to the whole chat; the location only to guardians.
    await post(`⚠️ ${d()} is at high risk (${dominant}). I've told them to pull over.`).catch(logPostError);
    await trip.resolvePlace(); // road and city for the text; falls back to the link alone
    const where = trip.locationText();
    if (where) await post(`📍 ${d()}'s location:\n${where}`, "guardian").catch(logPostError);
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
      case "dismiss": {
        // Tell the engine this alert was a false alarm: it eases this driver's dominant factor.
        const tripId = await engineTrip;
        const fb = risk && tripId && lastWindowTs
          ? await risk.feedback(tripId, { window_ts: lastWindowTs, verdict: "false_alarm" }).catch((err) => (console.error("[risk] feedback:", err), null))
          : null;
        if (fb) console.log(`[risk] false alarm: ${fb.factor} weight now x${fb.multiplier.toFixed(2)}`);
        sendToPhone({ type: "dismissed", factor: fb?.factor, multiplier: fb?.multiplier });
        driverQueue.enqueue({ text: ackLine("dismissed"), context: "info" });
        if (roast.active) await resolveRoast(text);
        return;
      }
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

  return { onPhone, onChat, onRiskEvaluation, setInsights, setRisk };
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
