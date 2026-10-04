// Plays the Android app so the backend can be tested without it.
//   npm run fake-phone             scripted demo run (calm -> drowsy -> microsleep)
//   npm run fake-phone -- -i       interactive: type commands (see HELP)
//   npm run fake-phone -- --contacts   contact frames: list, add (telegram and imessage), list, then exit
// Sends raw-signal risk_windows like the app; the backend's risk engine scores them and decides
// every alert. Received `speak` audio is saved to out/speak-N.mp3 and acked with speak_done.
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";

const url = process.env.PHONE_WS_URL ?? `ws://localhost:${process.env.PORT ?? 8787}/phone`;
const interactive = process.argv.includes("-i");
const contactsDemo = process.argv.includes("--contacts");
const HELP = `commands: start | end | win <calm|drowsy|micro|angry> [count] | say <text> [as <context>] | share <always|high_only|never> | kids <on|off>
          | contacts | add <telegram|imessage> <name> [guardian|friend] [phone] | rm <handle> | role <handle> <guardian|friend> | quit`;

mkdirSync("out", { recursive: true });
const ws = new WebSocket(url);
let speakCount = 0;
let lastContext = "free";
let lastTs = 0;

const send = (msg: object) => {
  console.log("→", JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Kind = "calm" | "drowsy" | "micro" | "angry";
/** Raw signals for one 10 s window, the same shape the app sends. */
function signals(kind: Kind) {
  const base = {
    face_visible: true, heart_rate: 72, breathing_rate: 15, eye_closure_frac: 0.05, longest_eye_closure_s: 0.3,
    yawns: 0, emotion_stress: 0.05, hard_brakes: 0, swerves: 0, speed_mph: 65, speed_limit_mph: 65,
  };
  if (kind === "drowsy" || kind === "micro") Object.assign(base, { heart_rate: 64, breathing_rate: 10.5, eye_closure_frac: 0.4, yawns: 1 });
  if (kind === "micro") base.longest_eye_closure_s = 2.2;
  if (kind === "angry") Object.assign(base, { heart_rate: 98, emotion_stress: 0.8, speed_mph: 84, hard_brakes: 1 });
  return base;
}

const win = (kind: Kind) => {
  lastTs = Math.max(Date.now(), lastTs + 1); // unique, increasing window timestamps
  const events = kind === "drowsy" || kind === "micro" ? ["yawn"] : kind === "angry" ? ["hard_brake"] : [];
  send({ type: "risk_window", ts: lastTs, speed: signals(kind).speed_mph, lat: 42.2808, lon: -83.743, events, signals: signals(kind) });
};

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "speak") {
    const file = `out/speak-${++speakCount}.mp3`;
    if (msg.audio) writeFileSync(file, Buffer.from(msg.audio, "base64"));
    lastContext = msg.listenAfterMs > 0 ? msg.context : "free";
    console.log(`← speak [tier ${msg.tier}, ${msg.context}${msg.listenAfterMs ? ", listening" : ""}] "${msg.text}"${msg.audio ? ` → ${file}` : " (no audio)"}`);
    setTimeout(() => ws.send(JSON.stringify({ type: "speak_done", id: msg.id })), 500);
  } else if (msg.type === "evaluation") {
    console.log(`← evaluation tier ${msg.tier} score ${msg.score} drowsy ${msg.levels.drowsy.toFixed(2)}${msg.override ? ` override=${msg.override}` : ""}${msg.calibrating ? " (calibrating)" : ""} actions=${msg.actions.join(",")}`);
  } else {
    console.log("←", JSON.stringify(msg));
  }
});

ws.on("open", async () => {
  send({ type: "hello", driverName: "Alex", sharingMode: "always", kidsInCar: false });
  if (interactive) return repl();
  if (contactsDemo) {
    send({ type: "contacts_list" });
    await sleep(300);
    send({ type: "contact_add", name: "Sam", role: "friend", platform: "telegram" });
    await sleep(300);
    send({ type: "contact_add", name: "Mom", role: "guardian", platform: "imessage", phone: "+15551234567" });
    await sleep(300);
    send({ type: "contacts_list" });
    await sleep(500);
    process.exit(0);
  }

  // Same profile as the app's demo mode: baseline, calm, drowsy (tier 2 after 3 drowsy windows), microsleep (tier 3).
  send({ type: "trip_start" });
  const plan: Kind[] = [...Array(13).fill("calm"), ...Array(12).fill("drowsy"), "micro", ...Array(3).fill("drowsy")];
  for (const kind of plan) { win(kind); await sleep(400); }
  await sleep(1500);
  send({ type: "utterance", text: "I'm fine", context: "checkin" });
  console.log("\nScripted run sent. Roast from the group chat; Ctrl+C to exit.\n");
});

async function repl() {
  console.log(HELP);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    switch (cmd) {
      case "start": send({ type: "trip_start" }); break;
      case "end": send({ type: "trip_end" }); break;
      case "win": {
        const kind = (rest[0] ?? "calm") as Kind;
        for (let i = 0; i < Number(rest[1] ?? 1); i++) { win(kind); await sleep(200); }
        break;
      }
      case "say": {
        const asIdx = rest.indexOf("as");
        const text = (asIdx >= 0 ? rest.slice(0, asIdx) : rest).join(" ");
        send({ type: "utterance", text, context: asIdx >= 0 ? rest[asIdx + 1] : lastContext });
        break;
      }
      case "share": send({ type: "settings", sharingMode: rest[0] }); break;
      case "kids": send({ type: "settings", kidsInCar: rest[0] === "on" }); break;
      case "contacts": send({ type: "contacts_list" }); break;
      case "add": send({ type: "contact_add", platform: rest[0], name: rest[1], role: rest[2] ?? "friend", phone: rest[3] }); break;
      case "rm": send({ type: "contact_remove", handle: rest[0] }); break;
      case "role": send({ type: "contact_update", handle: rest[0], role: rest[1] ?? "guardian" }); break;
      case "quit": process.exit(0);
      default: console.log(HELP);
    }
  }
}

ws.on("error", (err) => {
  console.error(`Could not connect to ${url}: ${err.message}. Is the backend running?`);
  process.exit(1);
});
