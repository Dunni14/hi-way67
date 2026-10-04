// Plays the Android app so the backend can be tested without it.
//   npm run fake-phone             scripted demo run
//   npm run fake-phone -- -i       interactive: type commands (see HELP)
// Received `speak` audio is saved to out/speak-N.mp3 and acked with speak_done.
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";

const url = process.env.PHONE_WS_URL ?? `ws://localhost:${process.env.PORT ?? 8787}/phone`;
const interactive = process.argv.includes("-i");
const HELP = `commands: start | end | win <R> [yawn,nod,...] | alert <40|70|85> [drowsy|reckless] | say <text> [as <context>] | share <always|high_only|never> | kids <on|off> | sim <calm|drowsy|reckless> <seconds> | quit`;

mkdirSync("out", { recursive: true });
const ws = new WebSocket(url);
let speakCount = 0;
let lastContext = "free";

const send = (msg: object) => {
  console.log("→", JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const win = (R: number, events: string[] = [], speed = 68) =>
  send({ type: "risk_window", ts: Date.now(), R, drowsy: R, reckless: R / 3, speed, lat: 42.2808, lon: -83.743, events });

// Streams synthetic 1 Hz `sensor_sample`s on a fast-forwarded clock so the
// backend risk engine (not this script) computes windows and alerts.
let simTs = Date.now();
const PROFILES: Record<string, (t: number) => object> = {
  calm: () => ({ hr: 72, breathing: 15, engagement: 0.9, eyeClosure: 0.02, stress: 0.05, speed: 60 }),
  drowsy: (t) => ({ hr: 56, breathing: 9, engagement: 0.3, eyeClosure: 0.45, stress: 0.05, yawn: t % 3 === 0, speed: 60 }),
  reckless: (t) => ({ hr: 98, breathing: 18, engagement: 0.7, eyeClosure: 0.02, stress: 0.7, speed: 88, hardBrake: t % 5 === 0, swerve: t % 7 === 0 }),
};
async function sim(profile: string, seconds: number) {
  const make = PROFILES[profile];
  if (!make) return console.log(HELP);
  for (let t = 0; t < seconds; t++) {
    simTs += 1000;
    ws.send(JSON.stringify({ type: "sensor_sample", ts: simTs, speedLimit: 65, lat: 42.2808, lon: -83.743, ...make(t) }));
    await sleep(20);
  }
  console.log(`sim ${profile}: sent ${seconds} samples`);
}

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "speak") {
    const file = `out/speak-${++speakCount}.mp3`;
    if (msg.audio) writeFileSync(file, Buffer.from(msg.audio, "base64"));
    lastContext = msg.listenAfterMs > 0 ? msg.context : "free";
    console.log(`← speak [tier ${msg.tier}, ${msg.context}${msg.listenAfterMs ? ", listening" : ""}] "${msg.text}"${msg.audio ? ` → ${file}` : " (no audio)"}`);
    setTimeout(() => ws.send(JSON.stringify({ type: "speak_done", id: msg.id })), 500);
  } else {
    console.log("←", JSON.stringify(msg));
  }
});

ws.on("open", async () => {
  send({ type: "hello", driverName: "Alex", sharingMode: "always", kidsInCar: false });
  if (interactive) return repl();

  send({ type: "trip_start" });
  for (let i = 0; i < 3; i++) (win(20), await sleep(300));
  win(45, ["yawn"]);
  send({ type: "alert", tier: 40, dominant: "drowsy", R: 45 });
  await sleep(4000);
  send({ type: "utterance", text: "I'm fine", context: "checkin" });
  await sleep(2000);
  win(88, ["yawn", "nod"]);
  win(90, ["yawn"]);
  send({ type: "alert", tier: 85, dominant: "drowsy", R: 90 });
  console.log("\nScripted run sent. Now roast from the group chat; Ctrl+C to exit.\n");
});

async function repl() {
  console.log(HELP);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    switch (cmd) {
      case "start": send({ type: "trip_start" }); break;
      case "end": send({ type: "trip_end" }); break;
      case "win": win(Number(rest[0] ?? 20), rest[1]?.split(",") ?? []); break;
      case "alert": send({ type: "alert", tier: Number(rest[0] ?? 40), dominant: rest[1] ?? "drowsy", R: Number(rest[0] ?? 40) + 5 }); break;
      case "say": {
        const asIdx = rest.indexOf("as");
        const text = (asIdx >= 0 ? rest.slice(0, asIdx) : rest).join(" ");
        send({ type: "utterance", text, context: asIdx >= 0 ? rest[asIdx + 1] : lastContext });
        break;
      }
      case "share": send({ type: "settings", sharingMode: rest[0] }); break;
      case "kids": send({ type: "settings", kidsInCar: rest[0] === "on" }); break;
      case "sim": await sim(rest[0] ?? "calm", Number(rest[1] ?? 60)); break;
      case "quit": process.exit(0);
      default: console.log(HELP);
    }
  }
}

ws.on("error", (err) => {
  console.error(`Could not connect to ${url}: ${err.message}. Is the backend running?`);
  process.exit(1);
});
