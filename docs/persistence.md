# Persistence (Tiger Data)

## Risk engine: Postgres / Tiger Data (done)

The risk engine REST API (`src/risk/`) persists to Postgres through `PgRiskStore`, and runs on Tiger Data (TimescaleDB). Details of the scoring are in [risk-engine.md](risk-engine.md); this section is what lives where.

**Connection.** `DATABASE_URL` opens one `pg.Pool` (max 5, 5 s connect timeout, 15 s statement timeout, idle errors logged) shared by the risk engine and, when `TIGER_DATABASE_URL` is set to the same URL, the bandit. A different `TIGER_DATABASE_URL` still works but logs a warning, because the bandit reads `windows` from the risk database. Tiger's certificate is not in Node's trust store: use `uselibpqcompat=true`, or see `.env.example`.

**Schema ownership.** On boot `PgRiskStore.migrate()` creates the portable tables, and `migrateTimescale()` (`risk/store/timescale.ts`) adds hypertables, the `windows_30s` / `trip_summary_5m` aggregates, retention and compression when the TimescaleDB extension is present. A failing step is logged and skipped. [`sql/01_schema.sql`](../backend/sql/01_schema.sql) is the reference, [`sql/03_policies.sql`](../backend/sql/03_policies.sql) holds the same retention and compression for applying by hand, and `schema.drift.test.ts` keeps the app and the SQL file in agreement. `drivers.profile` is added to an existing `drivers` table with `ADD COLUMN IF NOT EXISTS`. Never point these at the PROD-tagged service; the Tiger MCP refuses writes there anyway.

| Table | Holds | Kept |
|---|---|---|
| `windows` | Raw 10 s signals and computed levels, score, tier | 7 days (privacy), compressed after 1 day |
| `observations` | One expression label per window and the facial cues behind it | 7 days, compressed after 1 day |
| `events` | Every window where the tree fired an action | Forever |
| `decision_log` | Action, 8-number context, threshold used, feedback reward | Forever, compressed after 7 days |
| `report_cards` | One row per ended trip: score, grade, tier seconds, distance, speed and limit stats, counts, expression, interventions, driver profile before and after, `card` JSONB, 30 s `series`, `features` vector | Forever |
| `trips`, `drivers` | Trip context and baselines; sharing mode, weight multipliers, `profile` | Forever |
| `windows_30s`, `trip_summary_5m` | Continuous aggregates | Forever (they refresh inside the raw retention) |
| `driver_scorecard` (view) | Trips scored, average score (all time and 30 days), night trips, distance, time | Computed from `report_cards` |

Because raw windows expire after a week, **a trip's report must not depend on them**. At trip end the card stores its own 30 s series and metrics, and `GET /trips/{id}/report` and `/drivers/{id}/trips` fall back to them once `windows` is empty. Not stored anywhere: location, routes, video or face geometry, contact names or numbers.

**Checking an instance.** `npm run smoke:tiger` (needs `TIGER_DATABASE_URL`) runs a throwaway trip through windows, bandit, trip end and the card, then deletes its rows. With `DATABASE_URL` set, `npm test` also runs `risk/tiger.live.test.ts` against the instance (hypertables, policies, a full trip, report after the raw windows are dropped).

## Legacy phone path (stub)

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
