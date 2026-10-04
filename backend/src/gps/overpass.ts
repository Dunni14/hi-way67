// Minimal Overpass API client: a list of public instances tried in order, each with a hard timeout.
// Public instances are rate limited, so callers cache hard and treat every failure as "no answer".
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// Primary plus a backup run by a different operator. Override with OVERPASS_URLS (comma list). Public
// instances come and go (overpass.private.coffee and overpass.kumi.systems did not answer when this was
// written), so re-test the backup before a demo.
export const DEFAULT_OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.openstreetmap.fr/api/interpreter"];

export const overpassUrlsFromEnv = (env: string | undefined = process.env.OVERPASS_URLS): string[] => {
  const urls = (env ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : DEFAULT_OVERPASS_URLS;
};

export type OverpassOpts = { endpoints?: string[]; timeoutMs: number; fetch?: FetchLike };

/** An endpoint that just failed is skipped for this long, so a dead primary costs one timeout, not one per query. */
const SKIP_FAILED_MS = 60_000;
const failedUntil = new Map<string, number>();

/** Runs a query against each endpoint in turn; resolves with the first parsed JSON body, rejects if all fail. */
export async function overpass<T = unknown>(query: string, opts: OverpassOpts): Promise<T> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const all = opts.endpoints ?? overpassUrlsFromEnv();
  const healthy = all.filter((u) => (failedUntil.get(u) ?? 0) <= Date.now());
  const errors: string[] = [];
  for (const url of healthy.length ? healthy : all) {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "driver-guardian/0.0 (hackathon project)" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      failedUntil.delete(url);
      return (await res.json()) as T;
    } catch (err) {
      failedUntil.set(url, Date.now() + SKIP_FAILED_MS);
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(errors.join("; ") || "no Overpass endpoints configured");
}

export type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
};
export type OverpassResult = { elements?: OsmElement[] };
