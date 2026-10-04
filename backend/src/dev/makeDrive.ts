// Writes the synthetic test drive src/gps/fixtures/drive.gpx (deterministic, 1 Hz, no sensor noise).
//   npx tsx src/dev/makeDrive.ts
// Timeline (s): 0-30 parked, 30-60 pull away to 12 m/s, 60-120 cruise 12, 120-180 cruise 17 (speeding),
// 180-183 hard turn (60 deg/s, 180 deg total), 183-190 cruise 12, 190-230 coast down to a stop, 230-560 parked (long enough for the trip to end).
// Not a real recording: it exists so the replay test has a drive with a known shape.
import { writeFileSync } from "node:fs";

const START = Date.parse("2026-10-04T05:20:00Z");
const M_PER_DEG_LAT = 111_320;
let lat = 42.2808;
let lon = -83.743;
let heading = 90; // east
let speed = 0;

const speedAt = (t: number) => {
  if (t < 30) return 0;
  if (t < 60) return (12 * (t - 30)) / 30;
  if (t < 120) return 12;
  if (t < 130) return 12 + (5 * (t - 120)) / 10;
  if (t < 180) return 17;
  if (t < 190) return 12;
  if (t < 230) return Math.max(0, 12 * (1 - (t - 190) / 40));
  return 0;
};

const pts: string[] = [];
for (let t = 0; t <= 560; t++) {
  speed = speedAt(t);
  if (t >= 180 && t < 183) heading = (heading + 60) % 360;
  const d = speed; // metres in this 1 s step
  const rad = (heading * Math.PI) / 180;
  lat += (d * Math.cos(rad)) / M_PER_DEG_LAT;
  lon += (d * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  pts.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><time>${new Date(START + t * 1000).toISOString()}</time></trkpt>`);
}

const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="driver-guardian makeDrive.ts" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk>\n    <name>synthetic test drive</name>\n    <trkseg>\n${pts.join("\n")}\n    </trkseg>\n  </trk>\n</gpx>\n`;
writeFileSync(new URL("../gps/fixtures/drive.gpx", import.meta.url), gpx);
console.log(`wrote ${pts.length} points`);
