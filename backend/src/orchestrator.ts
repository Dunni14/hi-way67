// Wires phone events and chat messages together. This is where the README's
// decision-tree outputs (§4) turn into voice (§5) and chat actions (§6).
import { trip } from "./trip/state.ts";
import type { TripStore } from "./trip/store.ts";
import type { PhoneMsg, Tier, Dominant, DriverEvent } from "./ws/protocol.ts";
import { sendToPhone } from "./ws/server.ts";
import { driverQueue } from "./voice/driverQueue.ts";
import { ackLine, alertLine, messageLine, permissionLine, roastLine } from "./voice/lines.ts";
import { post, dm, type Inbound } from "./agent/spectrum.ts";
import { classify, shortenForSpeech } from "./agent/classifier.ts";
import { answerQuestion } from "./agent/answer.ts";
import { parseDriverUtterance } from "./agent/driverIntent.ts";
import { roast } from "./agent/roast.ts";
import { allContacts } from "./agent/contacts.ts";
import { riskEngine } from "./risk/engine.ts";
import type { Decision } from "./risk/tree.ts";

const LISTEN_MS = 5000;

export function createOrchestrator(store: TripStore) {
  const d = () => trip.driverName;
  let pendingPermission: { dominant: Dominant } | null = null;

  // ---- phone -> backend ----------------------------------------------------

  async function onPhone(msg: PhoneMsg) {
    switch (msg.type) {
      case "hello":
        if (msg.driverName) trip.driverName = msg.driverName;
        trip.sharingMode = msg.sharingMode;
        trip.kidsInCar = msg.kidsInCar;
        riskEngine.context = { kidsInCar: msg.kidsInCar, lowExperience: msg.lowExperience };
        riskEngine.sharing = msg.sharingMode;
        console.log(`[phone] hello: ${trip.driverName}, sharing=${trip.sharingMode}, kids=${trip.kidsInCar}`);
        return;

      case "settings":
        if (msg.sharingMode) trip.sharingMode = msg.sharingMode;
        if (msg.kidsInCar !== undefined) trip.kidsInCar = msg.kidsInCar;
        riskEngine.sharing = trip.sharingMode;
        riskEngine.context = {
          kidsInCar: trip.kidsInCar,
          lowExperience: msg.lowExperience ?? riskEngine.context.lowExperience,
        };
        return;

      case "trip_start":
        return onTripStart();

      case "trip_end":
        return onTripEnd();

      case "risk_window": {
        const { type: _, features, ...w } = msg;
        return recordWindow(w, features);
      }

      case "sensor_sample":
        return onSensorSample(msg);

      case "alert":
        return onAlert(msg.tier, msg.dominant, msg.R);

      case "utterance":
        return onUtterance(msg.text, msg.context);

      case "speak_done":
        driverQueue.done(msg.id);
        return;
    }
  }

  type WindowIn = Parameters<typeof trip.addWindow>[0];
  async function recordWindow(w: WindowIn, features?: Record<string, number>) {
    if (!trip.active) await onTripStart();
    trip.addWindow(w);
    if (w.events.includes("hard_brake")) driverQueue.pause();
    await store.saveWindow({ tripId: trip.tripId!, ...w, features }).catch((err) => console.error("[store] saveWindow:", err));
  }

  // Raw signals → risk engine → window + decision tree (backend/src/risk).
  const sampleEvents: DriverEvent[] = [];
  async function onSensorSample(m: Extract<PhoneMsg, { type: "sensor_sample" }>) {
    if (!trip.active) await onTripStart();
    const { type: _, lat, lon, ...sample } = m;
    if (m.hardBrake) sampleEvents.push("hard_brake");
    if (m.swerve) sampleEvents.push("swerve");
    if (m.yawn) sampleEvents.push("yawn");
    if (m.nod) sampleEvents.push("nod");
    const out = riskEngine.push(sample);
    if (!out) return;
    const { window: w, decision } = out;
    const events = [...new Set(sampleEvents.splice(0))];
    await recordWindow(
      { ts: w.ts, R: w.R, drowsy: w.drowsy, reckless: w.reckless, speed: m.speed ?? 0, lat, lon, events },
      w.features,
    );
    if (decision) await onDecision(decision);
  }

  async function onDecision(d: Decision) {
    console.log(`[tree] tier=${d.tier} ${d.dominant} R=${Math.round(d.R)}: ${d.reason}`);
    if (d.routeRestStop) sendToPhone({ type: "navigate", query: "rest stop" });
    // The tree already applied the kids-in-car bump.
    await onAlert(d.tier, d.dominant, d.R, true);
  }

  async function onTripStart() {
    if (trip.active) return;
    trip.start();
    riskEngine.startTrip(Date.now());
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

  async function onAlert(phoneTier: Tier, dominant: Dominant, R: number, bumped = false) {
    // Kids in the car bump the 70 tier up a level (README §4), unless the risk
    // engine's tree already did.
    const tier: Tier = !bumped && phoneTier === 70 && trip.kidsInCar ? 85 : phoneTier;
    trip.recordAlert(tier, dominant, R);
    console.log(`[alert] tier=${tier} (${dominant}) R=${Math.round(R)}`);

    if (tier < 85) {
      // Mid-tier: voice only, never the group chat.
      driverQueue.enqueue({ text: alertLine(tier, dominant), tier, context: "checkin", listenAfterMs: LISTEN_MS, priority: true });
      return;
    }

    driverQueue.enqueue({ text: alertLine(85, dominant), tier: 85, context: "checkin", listenAfterMs: 0, priority: true });
    if (trip.sharingMode === "never") {
      pendingPermission = { dominant };
      driverQueue.enqueue({ text: permissionLine(), tier: 85, context: "permission", listenAfterMs: LISTEN_MS });
      return;
    }
    await escalate(dominant);
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
        riskEngine.feedback("dismissed", Date.now());
        sendToPhone({ type: "dismissed" });
        driverQueue.enqueue({ text: ackLine("dismissed"), context: "info" });
        if (roast.active) await resolveRoast(text);
        return;
      case "yes":
        if (context === "checkin") {
          riskEngine.feedback("confirmed", Date.now());
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
        await space.responding(async () => message.reply(await answerQuestion(text, contact.name, contact.role)));
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

  return { onPhone, onChat };
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
