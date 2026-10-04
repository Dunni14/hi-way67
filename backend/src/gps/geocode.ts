// Reverse geocode a fix to "Road, City" for iMessage text (Nominatim by default). Best effort: every
// failure resolves null and the caller sends the maps link alone. Cached by rounded position, and the
// calls are rare (tier 3 alerts and location questions), well inside Nominatim's 1 request/s policy.
import type { FetchLike } from "./overpass.ts";

const URL_BASE = process.env.GEOCODER_URL?.trim() || "https://nominatim.openstreetmap.org/reverse";
const cache = new Map<string, string | null>();

export type Address = { road?: string; city?: string; town?: string; village?: string; hamlet?: string; suburb?: string };

/** "Main St, Ann Arbor". Either half alone if the other is missing, null if neither. */
export function placeName(a: Address | undefined): string | null {
  const city = a?.city ?? a?.town ?? a?.village ?? a?.hamlet ?? a?.suburb;
  return [a?.road, city].filter(Boolean).join(", ") || null;
}

export async function reverseGeocode(lat: number, lon: number, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<string | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key)!;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(`${URL_BASE}?format=jsonv2&zoom=16&addressdetails=1&lat=${lat}&lon=${lon}`, {
      headers: { "User-Agent": "driver-guardian/0.0 (hackathon project)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const name = placeName(((await res.json()) as { address?: Address }).address);
    cache.set(key, name);
    return name;
  } catch (err) {
    console.warn(`[gps] reverse geocode failed: ${(err as Error).message}`);
    return null; // not cached: a transient failure should be retried next time
  }
}
