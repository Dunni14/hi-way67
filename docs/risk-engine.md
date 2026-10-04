# Risk engine

The backend risk model in [`backend/src/risk/`](../backend/src/risk). It turns one 10 s window of driver signals into a score `R` (0–100), a tier (0–3) and a list of actions.

> **Status:** the engine and its tests exist as a self-contained, pure module. It is **not yet wired** into `orchestrator.ts` or `ws/protocol.ts`, so the live backend still trusts the phone's `R`, `drowsy`, `reckless` and `alert` frames. See [Integration](#integration).

Every weight and threshold lives in [`weights.json`](../backend/src/risk/weights.json), validated at load by `config.ts` (zod). Nothing is hardcoded in the logic.

## Pipeline

One call to `processWindow(state, window, ctx, cfg, mults)` in `decision.ts` runs these steps. It is pure: state in, state out, no I/O and no clock. The window's own `ts` is the clock.

```
SignalWindow ─► face check ─► baseline? ─► smooth ─► levels ─► score R ─► tier ─► overrides ─► kids bump ─► actions
```

| Step | File | What it does |
|---|---|---|
| Face check | `decision.ts` | 3 windows in a row with `face_visible: false` set `degraded`. Degraded scores speed and motion only. |
| Baseline | `smoothing.ts` | The first 6 windows only learn the driver's resting heart rate and breathing rate. They return tier 0, score 0. |
| Smoothing | `smoothing.ts` | Rolling mean of the last 3 windows. Nulls are ignored. Booleans and `longest_eye_closure_s` come from the newest window unaveraged, so a microsleep or a phone in hand is never diluted. |
| Levels | `levels.ts` | Six state levels, each 0..1. |
| Score | `score.ts` | Logistic-form score from the levels, sleep and trip context. |
| Tier | `decision.ts` | Score to tier, with a 2-window hold. |
| Overrides | `decision.ts` | Rules that raise the tier regardless of score. |
| Actions | `decision.ts` | Voice and notify actions with cooldowns. |

## Input: `SignalWindow`

Defined in `types.ts`. Every numeric field is nullable, and a null means "no evidence" and contributes 0.

| Field | Meaning |
|---|---|
| `ts` | ISO 8601, end of the 10 s window |
| `face_visible` | Camera sees the driver's face |
| `heart_rate`, `breathing_rate` | Presage vitals |
| `engagement` | 0..1, 1 = engaged |
| `eye_closure_frac` | Fraction of the window with eyes closed |
| `longest_eye_closure_s` | Longest single closure in seconds |
| `yawns` | Yawn count |
| `emotion_stress` | 0..1 |
| `gaze_off_road_s` | Seconds looking away from the road |
| `phone_in_hand` | Boolean |
| `hard_brakes`, `swerves` | Counts from the IMU |
| `speed_mph`, `speed_limit_mph` | Speed and the posted limit |

Trip-level context (`TripStart` / `TripContext`): `kidsInCar`, `lowExperience`, `sleepHours` (nullable), `sharingOn`.

## State levels

Each level is 0..1. Constants below are the defaults in `weights.json`.

| Level | Formula |
|---|---|
| `drowsy` | `0.4·min(eye/0.3, 1) + 0.2·min(yawns/3, 1) + 0.2·(1 − engagement) + 0.2·min(max(baselineBR − br, 0)/4, 1)` |
| `agitated` | `0.6·stress + 0.4·min(max(hr − baselineHR, 0)/25, 1)` |
| `speeding` | `clamp01(max(speed − limit, 0) / 20)` |
| `phone` | 1 if `phone_in_hand`, else 0 |
| `distracted` | `clamp01(gaze_off_road_s / 4)` |
| `erratic` | `clamp01((hard_brakes + swerves) / 3)` |

In degraded mode only `speeding` and `erratic` are computed; the other four are 0 and the sleep term is dropped.

## Score

From `score.ts`. A logistic-style sum, capped and scaled to 0..100:

```
z     = Σ w_i · mult_i · level_i  +  sleepTerm        (per-driver mult_i, default 1)
z     = min(z, ln(oddsCap))                            oddsCap = 50
rBase = 100 · z / ln(oddsCap)
m     = 1 + 0.15·kidsInCar + 0.15·lowExperience
R     = min(100, rBase · m)
```

| Factor | Weight `w` |
|---|---|
| `agitated` | 2.28 |
| `speeding` | 2.55 |
| `drowsy` | 1.22 |
| `phone` | 1.28 |
| `distracted` | 0.69 |
| `erratic` | 0.69 |

**Sleep term** (added only when `sleepHours` is known; first matching bucket wins):

| Sleep | Adds to `z` |
|---|---|
| under 4 h | 2.44 |
| 4 to under 5 h | 1.46 |
| 5 to under 6 h | 0.64 |
| 6 to under 7 h | 0.26 |
| 7 h or more | 0 |

**Sub-scores.** `score.ts` also returns `zDrowsy` (drowsy contribution + sleep) and `zReckless` (agitated + speeding + phone + distracted + erratic). `dominant` is `drowsy` when `zDrowsy >= zReckless`, otherwise `reckless`.

Reference values from the test suite (all other levels 0): drowsy only ≈ 31.2, agitated only ≈ 58.3, speeding only ≈ 65.2, drowsy + phone ≈ 63.9, agitated + half speeding ≈ 90.9, agitated + full speeding caps at 100.

## Tiers and the hold

| Tier | Score threshold | Voice action |
|---|---|---|
| 0 | below 40 | none |
| 1 | 40 | `voice_nudge` |
| 2 | 70 | `voice_warning` |
| 3 | 85 | `voice_urgent`, plus contact notification |

A score tier only counts after it holds for **2 consecutive windows** (`holdWindows`); the tier used is the lower of this window's and the previous window's raw tier. A single spike never fires.

## Overrides

Drowsiness scores low on its own (≈ 31), so a sleeping driver would never alert. These rules fix that. Microsleep skips the hold.

| Override | Condition | Result |
|---|---|---|
| `microsleep` | `longest_eye_closure_s ≥ 1.5` and not degraded | Tier 3 on that window |
| `drowsy_sustained_3` | `drowsy` level ≥ 0.6 for 3 windows | Tier raised to at least 2 |
| `drowsy_sustained_12` | `drowsy` level ≥ 0.6 for 12 windows (2 min) | Tier 3 |
| `tier2_sustained_12` | Tier 2 for 12 windows (2 min) | Tier 3 |

**Kids in the car** then raises any active tier (≥ 1) by one, up to 3. This is on top of the 15% score multiplier.

## Actions and cooldowns

- Voice: one action per tier (table above), at most once per **120 s per tier** (`cooldownS`).
- Tier 3 also emits `notify_contacts` when sharing is on, or `ask_permission_to_notify` when it is off. At most once per **600 s** (`notifyCooldownS`).
- Otherwise `["none"]`.

## Output: `Evaluation`

```ts
{ score, tier, dominant, actions, levels, override, degraded }
```

`score` is rounded to one decimal. `levels` carries all six state levels, so the app can show why a window scored as it did.

## Per-driver adaptation

`WeightMults` is a per-factor multiplier on `w`, default 1 and clamped by `feedback.min` / `feedback.max` (0.5 to 1.5). Feedback is a `window_ts` plus a verdict:

| Verdict | Multiplier step (`weights.json`) |
|---|---|
| `false_alarm` | × 0.95 |
| `confirmed` | × 1.05 |

`dominantFactor()` in `score.ts` picks the factor contributing most to `z`, which is the one feedback should adjust. This replaces the phone-side "I'm fine" gradient step described in [phone-app.md](phone-app.md).

## Integration

The engine is not connected to anything yet. What wiring it needs:

1. Add a `signal_window` frame to `ws/protocol.ts` (and to [protocol.md](protocol.md) and `backend/PROTOCOL.md`) carrying a `SignalWindow`, plus trip-start fields for `kids_in_car`, `low_experience`, `sleep_hours`.
2. Keep an `EngineState` per trip (it holds the baseline, smoothing buffer, streaks and cooldown clocks) in `trip/state.ts`.
3. Call `processWindow` from the orchestrator and turn `actions` into `driverQueue` lines and guardian posts.
4. Persist per-driver `WeightMults` through the `TripStore`.
5. **Remove the orchestrator's own 70 → 85 kids-in-car bump.** The engine already raises the tier for kids, so keeping both would double-count.
6. Decide whether `risk_window` / `alert` stay for older phones.

## Tests

```sh
cd backend
npm run test      # tsx --test src/risk/*.test.ts
```

`engine.test.ts` covers the spec scenarios: neutral windows, each single factor, combinations, score cap, microsleep, hold, cooldown, null fields, degraded mode, sustained overrides, the notify cooldown, the sleep term and per-driver multipliers.
