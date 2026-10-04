// Minimal Overpass API client: a list of public instances tried in order, each with a hard timeout.
// Public instances are rate limited, so callers cache hard and treat every failure as "no answer".
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// Primary plus a backup instance. Override with OVERPASS_URLS (comma list). Pick and test the backup before a demo.
export const DEFAULT_OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

export const overpassUrlsFromEnv = (env: string | undefined = process.env.OVERPASS_URLS): string[] => {
  const urls = (env ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : DEFAULT_OVERPASS_URLS;
};

export type OverpassOpts = { endpoints?: string[]; timeoutMs: number; fetch?: FetchLike };

/** Runs a query against each endpoint in turn; resolves with the first parsed JSON body, rejects if all fail. */
export async function overpass<T = unknown>(query: string, opts: OverpassOpts): Promise<T> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  let lastErr: unknown = new Error("no Overpass endpoints configured");
  for (const url of opts.endpoints ?? overpassUrlsFromEnv()) {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "driver-guardian/0.0 (hackathon project)" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = new Error(`${url}: ${(err as Error).message}`);
    }
  }
  throw lastErr;
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
