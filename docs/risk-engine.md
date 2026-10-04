# Risk engine

Backend service that turns a 10 s signal window into a risk score, a tier and actions. Clients (the Android app, the orchestrator, the Photon agent) call it; it never calls ElevenLabs or Photon itself.

Code: `backend/src/risk/` (pure core, service, Postgres store), `backend/src/http/risk.ts` (REST). Tests: `npm test` in `backend/`.

## Enabling it

Set `DATABASE_URL` (see `.env.example`; it points at the Tiger Data service). The operational tables (`drivers`, `trips`, `windows`, `events`) match [`backend/sql/01_schema.sql`](../backend/sql/01_schema.sql) and `risk/store/schema.ts` creates any that are missing on boot. On TimescaleDB, `migrateTimescale()` also applies the hypertables, the `windows_30s` and `trip_summary_5m` aggregates, 7-day retention on `windows` and `observations`, and compression; the config tables (`02_seed.sql`) are still applied once with the Tiger MCP or `psql`. See [persistence.md](persistence.md) for what is stored where and for how long. Without `DATABASE_URL` the REST API is off and the legacy phone-computed path (`risk_window` / `alert` frames) keeps working. Mapping notes: the API's `high_only` is stored as `high_risk_only`; `events.override` holds the `override_rules.rule_id` (microsleep 1, drowsy_sustained_3 2, drowsy_sustained_12 3, tier2_sustained_12 4); `windows.result` keeps the full evaluation for `/trips/{id}/state`. The engine still reads weights from `risk/weights.json`, not the config tables.

**No database? Use the fake one.** `npm run dev:fake` (or `FAKE_DB=1`) runs the REST API on an in-process Postgres (PGlite, `src/dev/fakeDb.ts`) with the same schema, the seeded config tables, plain-view stand-ins for `windows_30s` / `trip_summary_5m`, and 12 deterministic trips (drivers `alex`, `sam`, `jo`; calm, drowsy, aggressive and phone-use segments, all four tiers) generated through the real `RiskService`, so events and grades are genuine. Try `GET /drivers/alex/trips` and `GET /trips/fake-alex-2/report`. If `DATABASE_URL` is set but unreachable, boot logs a warning and falls back to it. Data is in memory and regenerated each boot unless `FAKE_DB_DIR` is set. Timestamps are relative to boot, so the week of history always looks recent. `npm run seed:fake` prints a summary.

## Flow

```
window ─> smooth (3) ─> state levels ─> z = Σ w·x (capped ln 50) ─> R 0..100 ─> hold, overrides, cooldowns ─> tier + actions
```

| File | Role |
|---|---|
| `weights.json` / `config.ts` | **Every** weight and threshold (odds-ratio weights, sub-weights, sleep table, tiers, cooldowns). Zod-validated at load. |
| `levels.ts` | Spec §4 levels (drowsy, agitated, speeding, phone, distracted, erratic). Null = no evidence. |
| `score.ts` | Spec §5: `z`, sleep term, cap, `R`, context multiplier, drowsy/reckless sub-scores. |
| `decision.ts` | `processWindow(state, window, ctx)`: baseline, smoothing, 2-window hold, overrides, kids raise, cooldowns, degraded mode. Pure. |
| `service.ts` | Trip lifecycle, per-driver feedback, report. Rebuilds in-memory state after a restart by replaying stored windows. |
| `store/` | `RiskStore` interface and `PgRiskStore` (`pg` in prod, PGlite in tests). |

## Endpoints

| Method and path | Purpose |
|---|---|
| `POST /trips` | Start a trip: `{driver_id, kids_in_car, low_experience, sleep_hours?, sharing_mode?, share_location?}` -> `{trip_id}` |
| `POST /trips/{id}/windows` | One signal window every 10 s, optionally with `gps: {fixes: [...]}` (see [gps.md](gps.md)) -> `{score, tier, dominant, actions, levels, override, degraded, gps?}`. `gps` is `{ok, speed_mps, limit_mph, limit_source, stopped, moving, trip_ended?}`, no coordinates |
| `POST /trips/{id}/feedback` | `{window_ts, verdict: "false_alarm" \| "confirmed"}`; scales the dominant factor's weight x0.95 / x1.05, clamped 0.5x..1.5x, per driver |
| `POST /trips/{id}/end` | Close the trip; writes the report card once and updates the driver profile -> `{trip_id, ended, card}` |
| `GET /trips/{id}/state` | Latest response object (for the Photon agent) |
| `GET /trips/{id}/report` | Series, events, max score, seconds per tier, grade A-D (max tier), plus `card` |
| `GET /trips/{id}/card` | Report card: stored after the trip ended, computed live before. `gps` holds the route, alert markers and limit stats |
| `GET /trips/{id}/observations` | The stored expression label for every window |
| `GET /drivers/{id}/trips` | Past trips with grades and `card_score` / `card_grade` |
| `GET /drivers/{id}/profile` | `careIndex`, `scoredTrips`, `learnedShift`, current `notify_threshold`, weight multipliers, and `scorecard` (the `driver_scorecard` view: scored trips, average score, 30-day average, night trips, distance) |

Errors: 400 invalid body, 404 unknown trip or window, 409 ended trip or duplicate `ts`.

## GPS

The window takes an optional `gps` field: up to 10 fixes (`t, lat, lon, speed_mps, heading_deg, h_accuracy_m`). Absent keeps the legacy `speed_mph` / `speed_limit_mph` formula; `null` or present makes GPS authoritative for `speeding` (0 without good fixes or a known limit) and adds `erratic_gps`. A trip also starts and ends itself from GPS speed. Everything, including the thresholds, the posted-limit lookup, storage and privacy, is in [gps.md](gps.md).

## Behavior notes

- First 6 windows set the baseline heart/breathing rate and return tier 0.
- A score tier must hold for 2 consecutive windows; microsleep (`longest_eye_closure_s >= 1.5`) bypasses that. Overrides 2-4 are floors; the kids raise is applied last.
- Cooldown only suppresses the voice action; `tier` and `score` are still returned. `notify_contacts` is limited to once per 10 min per trip.
- `sharing_mode: "never"` on the driver turns `notify_contacts` into `ask_permission_to_notify`. `sharing_mode` is an optional field on `POST /trips` (the spec has the column but no way to set it).
- Smoothing applies to numeric signals; booleans and `longest_eye_closure_s` use the newest window so a microsleep isn't averaged away.

## Report card and adaptive notify threshold

Code: `risk/expression.ts`, `risk/card.ts`, `risk/profile.ts`; all numbers are in `weights.json` (`expression`, `report`, `adaptive`). Tests: `risk/report.test.ts` and the last two tests in `risk/api.test.ts`.

**Observations.** Every window also stores one expression label in `observations`: `no_face` > `drowsy` (eye closure, yawns or a long blink) > `stressed` > `distracted` (gaze off road or phone) > `calm` > `neutral`, with an intensity 0..1 and the cues behind it. Labels use raw signals only, so they can be re-derived.

**Final score** (0..100, higher is better, `formula_version` 1), over scored windows (the baseline windows are skipped):

```
penalty = 0.3*meanRisk + 0.2*p90Risk + 30*tier2Frac + 30*tier3Frac + 10*min(microsleeps, 3)
score   = clamp(100 - penalty, 0, 100)
```

`tier2Frac` is the share of windows at tier >= 2 and `tier3Frac` the share at tier 3, so a tier 3 window is charged both. Grade: A >= 90, B >= 80, C >= 65, D >= 50, else F. This is separate from the older `grade` (A-D by highest tier reached), which is kept. Five category scores (attention, speed, smoothness, alertness, composure) use `100 * (1 - (0.5*mean(level) + 0.5*share(level >= 0.6)))`. `confidence` is scored windows / 60, capped at 1; a card under 12 scored windows is `provisional`. The card also carries expression shares, counts, and `features` (a fixed-order vector, names in `feature_names`) for offline learning. It is stored in `report_cards` when the trip first ends, together with trip metrics (duration, distance, speed and time over the limit, seconds per tier, yawns, longest eye closure, gaze-off-road and phone seconds, heart rate above baseline, intervention counts by type, overrides fired, feedback given, and the driver's care index and notify threshold before and after) and a 30 s `series`, so the report keeps working after the raw windows expire.

**Adaptive threshold.** `drivers.profile` holds `careIndex` (starts 75; each non-provisional card moves it toward the trip score by `0.3 * confidence`) and `learnedShift`. The score needed to text a friend is `clamp(85 + 0.5*(careIndex - 75) + learnedShift, 60, 95)`: a careless history lowers it (down to 60, so tier 2 can notify), a careful one raises it (up to 95, so a plain score-driven tier 3 stays voice only). Overrides (microsleep, sustained drowsiness) and the kids-in-car rule still notify regardless; voice tiers and the 10-minute notify cooldown are unchanged. A new driver sits at 85, the old behavior.

**Reinforcement data.** Each window that triggers an action also writes a `decision_log` row: 8-number context (six levels, kids, low experience), the most severe action, and `scores` (risk score, threshold used). `POST /trips/{id}/feedback` sets its `reward` (+1 confirmed, -1 false alarm); on a notify action it also moves `learnedShift` by +2 (false alarm) or -1 (confirmed), clamped to +/-10. `decision_log` is deliberately not `bandit_events`: the bandit below trains on every unrewarded row there, so these decisions (`notify_contacts`, `voice_urgent`, tier 3) must stay out of it. Nothing learns from `decision_log` yet. On a restart, replay uses the driver's current threshold.

## Adaptive recommendations (contextual bandit)

A learning layer that picks **which** intervention the driver hears, within the tier the decision tree already chose. It never changes tiers, thresholds, overrides, cooldowns or `actions`, and tier 3 is never learned.

Code: `backend/src/bandit/`. Config: `bandit/bandit.json` (alpha, 120 s reward delay, reward scale and adjustments, context caps, the action table and per-tier defaults). Enable with `TIGER_DATABASE_URL` (Tiger Data = Postgres + TimescaleDB; needs `DATABASE_URL` too). Unset = off, and responses are exactly as before.

| File | Role |
|---|---|
| `linucb.ts` | LinUCB over (A, b, x, r): init, solve (Gaussian elimination, no explicit inverse), UCB score, choose, update. Pure. |
| `reward.ts` | Reward from before/after target levels plus adjustments, the 8-value context vector, allowed actions per tier and dominant. Pure. |
| `service.ts` | `select` (tier 1/2 voice action -> intervention) and `processRewards` (runs on every incoming window, no worker). |
| `store.ts` | `bandit_events` (hypertable on `ts` when TimescaleDB is present) and `bandit_models`. |

- `POST /trips/{id}/windows` gains `intervention: {id, event_ts, learned}`, only on a tier 1 or 2 voice action. `learned` is false when the default was picked and the driver has no updates for those actions. The client uses `intervention.id` to choose the ElevenLabs script.
- `GET /drivers/{id}/policy` -> `{driver_id, actions: [{action, updates, mean_reward}]}`. 404 when the bandit is off.
- Context `x` (d = 8, all 0..1): bias, drowsy, agitated, speeding, trip minutes / 120, night (22:00-05:59 server local time), kids in car, interventions this trip / 5.
- Reward, 120 s after the intervention: `clamp((mean target before - mean target after) / 0.3, -1, 1)`, +1 if the driver stopped (speed 0 for 60 s) after a drowsy intervention, -0.5 on `false_alarm` feedback, -0.5 if the tier went up; clamped to [-1, 2]. No reward and no update when the trip ended first, the face was hidden for most of the period, or there are no windows to compare.
- Before/after levels are read from the `windows` table in `DATABASE_URL` (not migrated). The first 6 baseline windows carry no levels and are skipped.
- Model updates are serialized per driver inside the process; two backend instances sharing one database would still need a database-level lock.
- `family_voice_warning` is only offered when `ELEVENLABS_FAMILY_VOICE_ID` is set (one recorded voice for the app). The orchestrator speaks that action with this voice.
- Deviations from the spec: the linear algebra is plain TypeScript (this backend has no numpy); `bandit_events` has an extra `false_alarm` column so feedback survives until the reward is computed.

## In-process bridge

`RiskService` takes an `onEvaluation(tripId, evaluation, intervention?)` hook. `index.ts` passes `orchestrator.onRiskEvaluation`, which maps tier 1/2/3 to the existing 40/70/85 voice and iMessage path (`onAlert`) and carries out what the engine asked for:

- A `voice_*` action speaks a line. For tier 1/2 with a bandit intervention it is that action's script (`voice/lines.ts`, `interventionLine`); otherwise the generic `alertLine`. Only `suggest_rest_stop` listens for a yes/no (yes navigates to a rest stop); other interventions do not listen, so a free-form reply is not relayed to the group chat.
- `notify_contacts` posts the guardian alert (and starts the roast for drowsy), `ask_permission_to_notify` asks the driver. Both come from the engine, so its 10 min notify cooldown applies; before, the orchestrator re-posted at every tier 3 voice action.
- The legacy phone `alert` path is unchanged: it still decides from the phone's `sharingMode`.

Guardians who ask the Photon agent "what works for Alex" get the bandit's best action (at least 2 updates and a positive mean reward) as an extra fact, unless sharing is off.
