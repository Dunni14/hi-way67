// Small-distance geometry on a local flat projection. Good to well under a metre at the 25 m to 15 km
// scales used here, and dependency-free.
const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

type LL = { lat: number; lon: number };

/** Great-circle distance in metres. */
export function distanceM(a: LL, b: LL): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from a to b, 0..360. */
export function bearingDeg(a: LL, b: LL): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Angle between two bearings ignoring direction of travel (a road is the same road both ways): 0..90. */
export function undirectedDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/** Distance from `p` to the nearest point of a polyline, and the bearing of that nearest segment. */
export function nearestOnPolyline(p: LL, line: LL[]): { distanceM: number; bearing: number } | null {
  if (line.length < 2) return null;
  const cos = Math.cos(rad(p.lat));
  const toXY = (q: LL) => ({ x: rad(q.lon - p.lon) * cos * R, y: rad(q.lat - p.lat) * R });
  let best: { distanceM: number; bearing: number } | null = null;
  for (let i = 1; i < line.length; i++) {
    const a = toXY(line[i - 1]!);
    const b = toXY(line[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * dx + a.y * dy) / len2));
    const d = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (!best || d < best.distanceM) best = { distanceM: d, bearing: bearingDeg(line[i - 1]!, line[i]!) };
  }
  return best;
}
