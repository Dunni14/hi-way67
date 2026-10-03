// npm run smoke:tts  ->  writes out/tts-{0,40,70,85}.mp3 so you can hear the tiers.
import { mkdirSync, writeFileSync } from "node:fs";
import { tts } from "../voice/elevenlabs.ts";
import { alertLine } from "../voice/lines.ts";

mkdirSync("out", { recursive: true });
const cases = [
  [0, "Message from Mom: grab coffee at the next exit."],
  [40, alertLine(40, "drowsy")],
  [70, alertLine(70, "drowsy")],
  [85, alertLine(85, "drowsy")],
] as const;

for (const [tier, text] of cases) {
  const audio = await tts(text, tier);
  writeFileSync(`out/tts-${tier}.mp3`, audio);
  console.log(`out/tts-${tier}.mp3  (${audio.length} bytes)  "${text}"`);
}
