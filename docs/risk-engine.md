# Risk engine

Backend service that turns a 10 s signal window into a risk score, a tier and actions. Clients (the Android app, the orchestrator, the Photon agent) call it; it never calls ElevenLabs or Photon itself.

Code: `backend/src/risk/` (pure core, service, Postgres store), `backend/src/http/risk.ts` (REST). Tests: `npm test` in `backend/`.

## Enabling it

Set `DATABASE_URL` (any Postgres; Tiger Data / TimescaleDB works). Tables are created on boot. Without it the REST API is off and the legacy phone-computed path (`risk_window` / `alert` frames) keeps working. A TimescaleDB hypertable on `windows(ts)` is one commented statement in `risk/store/schema.ts`.

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
| `POST /trips` | Start a trip: `{driver_id, kids_in_car, low_experience, sleep_hours?, sharing_mode?}` -> `{trip_id}` |
| `POST /trips/{id}/windows` | One signal window every 10 s -> `{score, tier, dominant, actions, levels, override, degraded}` |
| `POST /trips/{id}/feedback` | `{window_ts, verdict: "false_alarm" \| "confirmed"}`; scales the dominant factor's weight x0.95 / x1.05, clamped 0.5x..1.5x, per driver |
| `POST /trips/{id}/end` | Close the trip |
| `GET /trips/{id}/state` | Latest response object (for the Photon agent) |
| `GET /trips/{id}/report` | Series, events, max score, seconds per tier, grade A-D |
| `GET /drivers/{id}/trips` | Past trips with grades |

Errors: 400 invalid body, 404 unknown trip or window, 409 ended trip or duplicate `ts`.

## Behavior notes

- First 6 windows set the baseline heart/breathing rate and return tier 0.
- A score tier must hold for 2 consecutive windows; microsleep (`longest_eye_closure_s >= 1.5`) bypasses that. Overrides 2-4 are floors; the kids raise is applied last.
- Cooldown only suppresses the voice action; `tier` and `score` are still returned. `notify_contacts` is limited to once per 10 min per trip.
- `sharing_mode: "never"` on the driver turns `notify_contacts` into `ask_permission_to_notify`. `sharing_mode` is an optional field on `POST /trips` (the spec has the column but no way to set it).
- Smoothing applies to numeric signals; booleans and `longest_eye_closure_s` use the newest window so a microsleep isn't averaged away.

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
- Before/after levels are read from the `windows` table in `DATABASE_URL` (not migrated).
- `family_voice_warning` is only offered when `BanditService`'s `hasFamilyVoice(driverId)` lookup returns true. Nothing in the repo records a family voice yet, so the default lookup says no.
- Deviations from the spec: the linear algebra is plain TypeScript (this backend has no numpy); `bandit_events` has an extra `false_alarm` column so feedback survives until the reward is computed.

## In-process bridge

`RiskService` takes an `onEvaluation` hook. `index.ts` passes `orchestrator.onRiskEvaluation`, which maps tier 1/2/3 to the existing 40/70/85 voice and iMessage path (`onAlert`) when the engine returned a voice action. The sharing decision there still follows the phone's `sharingMode`; the engine's own `notify` actions are advisory for REST clients.
