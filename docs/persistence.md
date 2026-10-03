# Persistence (Tiger Data)

**Status: Stub.** The backend writes through a `TripStore` interface, but the only implementation is `InMemoryTripStore`, which loses everything on restart. There is no Tiger Data / Timescale client, schema, migration or connection setting in the repo. [`src/index.ts`](../backend/src/index.ts) marks the swap point:

```ts
// TODO(tiger-data): swap in the Timescale-backed TripStore when it's ready.
const store = new InMemoryTripStore();
```

## Interface

[`src/trip/store.ts`](../backend/src/trip/store.ts):

```ts
interface TripStore {
  startTrip(trip: TripSummary): Promise<void>;
  endTrip(tripId: string, patch: Partial<TripSummary>): Promise<void>;
  saveWindow(w: WindowRecord): Promise<void>;
  getRecentTrips(driverName: string, sinceMs: number): Promise<TripSummary[]>;
  getContactPrefs(handle: string): Promise<ContactPrefs>;
  setContactPrefs(handle: string, prefs: ContactPrefs): Promise<void>;
}

type WindowRecord = {
  tripId: string; ts: number; R: number; drowsy: number; reckless: number;
  speed: number; lat?: number; lon?: number; events: string[];
  features?: Record<string, number>;
};
type TripSummary = { tripId: string; driverName: string; startedAt: number; endedAt?: number; maxR: number; alerts: number };
type ContactPrefs = { notifyOnArrival?: boolean };
```

## Who calls it

| Call | When | Used for |
|---|---|---|
| `startTrip` | `trip_start`, or the first `risk_window` | Trip history |
| `saveWindow` | Every `risk_window`. Errors are logged, not thrown. | Trip timeline / report card |
| `endTrip` | `trip_end` | Duration, alert count, peak R |
| `getRecentTrips` | Trip start, `always` mode, at night | "3rd late-night drive this week" |
| `getContactPrefs` / `setContactPrefs` | `arrival_pref` message; `trip_end` | One-shot arrival DM |

Trip ids are `trip-<epoch ms>`. Timestamps are epoch milliseconds.

## Suggested Timescale schema (not implemented)

A starting point for whoever writes the real store:

```sql
CREATE TABLE trips (
  trip_id     text PRIMARY KEY,
  driver_name text NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  max_r       double precision NOT NULL DEFAULT 0,
  alerts      integer NOT NULL DEFAULT 0
);

CREATE TABLE risk_windows (
  ts        timestamptz NOT NULL,
  trip_id   text NOT NULL REFERENCES trips(trip_id),
  r         double precision NOT NULL,
  drowsy    double precision NOT NULL,
  reckless  double precision NOT NULL,
  speed     double precision NOT NULL,
  lat       double precision,
  lon       double precision,
  events    text[] NOT NULL DEFAULT '{}',
  features  jsonb
);
SELECT create_hypertable('risk_windows', 'ts');

CREATE TABLE contact_prefs (
  handle            text PRIMARY KEY,
  notify_on_arrival boolean NOT NULL DEFAULT false
);
```

To finish this, add a Postgres client dependency and a connection string variable to `.env.example`, then implement `TripStore` against these tables and swap it into `index.ts`.

## Not started

- Report card: risk-over-time chart, letter grade, advice
- Weekly trends (worst times of day)
- Any read API for windows. The interface has no `getWindows(tripId)` yet, and the report card will need one.
