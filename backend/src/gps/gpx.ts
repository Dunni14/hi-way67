// GPX track to GPS fixes, for replaying a drive through the pipeline (tests and the dev replay script).
// Speed comes from `<extensions><speed>` when the logger wrote it, otherwise from distance over time
// between points; heading is the bearing from the previous point. Accuracy is a fixed good value.
import { bearingDeg, distanceM } from "./geo.ts";
import type { GpsFix } from "./types.ts";

export function fixesFromGpx(xml: string, accuracyM = 5): GpsFix[] {
  const pts = [...xml.matchAll(/<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*>([\s\S]*?)<\/trkpt>/g)].map((m) => ({
    lat: Number(m[1]),
    lon: Number(m[2]),
    ms: Date.parse(/<time>([^<]+)<\/time>/.exec(m[3]!)?.[1] ?? ""),
    speed: /<speed>([-\d.]+)<\/speed>/.exec(m[3]!)?.[1],
  }));
  return pts
    .filter((p) => !Number.isNaN(p.ms))
    .map((p, i) => {
      const prev = pts[i - 1];
      const next = pts[i + 1];
      const [a, b] = prev ? [prev, p] : [p, next ?? p];
      const dt = (b.ms - a.ms) / 1000;
      const derived = dt > 0 ? distanceM(a, b) / dt : 0;
      return {
        t: new Date(p.ms).toISOString(),
        lat: p.lat,
        lon: p.lon,
        speed_mps: p.speed != null ? Number(p.speed) : derived,
        heading_deg: a.lat === b.lat && a.lon === b.lon ? null : bearingDeg(a, b),
        h_accuracy_m: accuracyM,
      };
    });
}
