# Risk engine and decision tree

Code: `backend/src/risk/`. Tests: `npm test` (17 cases). Pure TypeScript with no I/O, so the same logic can be ported to the Android app if scoring ever has to run on the phone.

The phone can pick either mode:

| Mode | Phone sends | Backend does |
|---|---|---|
| **Engine (new)** | [`sensor_sample`](protocol.md#sensor_sample) at ~1 Hz | Baseline, smoothing, scoring, decision tree, then the existing voice / iMessage actions |
| Legacy | `risk_window` + `alert` | Trusts the phone's `R` and tier |

## Pipeline

```
sensor_sample (1 Hz) ─> SignalProcessor ─> feature vector x ─> score() ─> DecisionTree ─> Decision
                        baseline 60 s        11 values, 0..1    R, drowsy,   hold 15 s      tier, voice,
                        10 s rolling mean                       reckless     cooldown       rest stop, notify
                        missing-face logic                                   sustain 2 min
```

| File | Role |
|---|---|
| `signals.ts` | 60 s per-trip baseline, 10 s rolling mean, missing-face handling, raw → features |
| `features.ts` | The feature vector and normalizers |
| `score.ts` | `r = w · x`, `m = 1 + c · k`, `R = clamp(100 · r · m, 0, 100)`, default weights |
| `adapt.ts` | Gradient nudge on dismiss / confirm, ridge least-squares fit |
| `tree.ts` | Tiers 40 / 70 / 85, hold, cooldown, sustain, kids bump, back-off, sharing |
| `engine.ts` | Ties them together per driver; weights persist across trips |
| `linalg.ts` | dot, matmul, transpose, Gaussian solve, ridge |

## Feature vector

The README lists `breathing_dev`, `heart_rate_dev` and `engagement`. They are split here so a linear `w · x` can tell drowsy from reckless: heart rate falling means drowsy and spiking means reckless, but a single magnitude cannot say which. Everything is still 0..1.

| # | Feature | From |
|---|---|---|
| 0 | `breathing_drop` | Breathing below baseline (40% drop = 1) |
| 1 | `hr_drop` | Heart rate below baseline (25% drop = 1) |
| 2 | `hr_spike` | Heart rate above baseline (30% rise = 1) |
| 3 | `engagement_loss` | 1 − engagement vs. baseline; also gaze-off-road fraction |
| 4 | `eye_closure` | Closure fraction (0.3 = 1) plus 0.25 per yawn or nod in the window |
| 5 | `emotion_stress` | Anger / stress expression |
| 6 | `hard_brake_count` | Count in window (3 = 1) |
| 7 | `swerve_count` | Count in window (3 = 1) |
| 8 | `speed_over_limit` | Mph over limit (20 = 1). Default limit 65 if the phone sends none |
| 9 | `hours_driving` | Trip hours (4 h = 1) |
| 10 | `night_time` | 22:00–05:00 |

Two weight vectors over the same `x` give the drowsy and reckless sub-scores. Combined `R = max(drowsy, reckless)` and the larger one is `dominant` (ties go to drowsy). The README's single `w` is replaced by the pair so the tree knows which one fired.

**Context multiplier.** `m = 1 + 0.25·kids_in_car + 0.15·low_experience`. With zero risk it still gives zero. `lowExperience` is new on `hello` / `settings`.

## Signal handling

- **Baseline:** the first 60 s of face data give per-trip baselines for heart rate, breathing and engagement. It needs 20 valid samples and keeps collecting otherwise. While calibrating, vital-based features are *unavailable*; eye closure, stress and phone sensors still score.
- **Smoothing:** every signal goes through a 10-sample rolling mean. A window with fewer than 5 present samples counts as missing, so a single blink or a dropped frame changes nothing.
- **Face lost:** Presage features become unavailable (not zero). The weight of the remaining features is scaled up by `total / remaining`, capped at 2x, so phone sensors carry the score without becoming jumpy.

## Decision tree

| Rule | Behavior |
|---|---|
| R < 40 | Nothing. The window is still logged. |
| 40 ≤ R < 70 | Drowsy: `checkin` voice. Reckless: `reminder` voice. |
| 70 ≤ R < 85 | `warning` voice. Drowsy also sets `routeRestStop`. With kids in the car this is tier 85. |
| R ≥ 85, or 70+ for 2 min | `urgent` voice. `notify` is `send` when sharing is `always` or `high_only`, `ask` when `never`. |
| Hold | R must stay at or above a threshold for 15 s. A dip resets that threshold's timer. |
| Cooldown | After a tier fires, that tier and anything below it stay quiet for 2 min. A higher tier fires straight away. |
| "I'm fine" | Backs off tiers below 85 for 5 min. Tier 85 is never silenced; the cooldown still applies. |

Because windows arrive every 10 s, a threshold crossing fires on the second window after it (about 20 s), the first at which the 15 s hold is satisfied.

## Learning

- **Nudge:** `dismissed` and `confirmed` each take one gradient step on ½(w·x − y)² with `y = r ∓ 0.15`, learning rate 0.3, using the most recent window. Only the dominant vector moves, and weights stay in `[0, 1]`. The orchestrator calls it on "I'm fine" (dismissed) and on "yes" to the rest-stop offer (confirmed).
- **Fit:** `fitWeights(X, y)` solves `w = (XᵀX + λI)⁻¹Xᵀy` with clipping at 0. Nothing calls it yet; it is ready for labeled windows from the survey or reviewed trips. Weights live in memory and reset on restart.

## Try it without a phone

```bash
cd backend && npm start          # one terminal
npm run fake-phone -- -i         # another
> start
> sim calm 90                    # baseline + low score
> kids on
> sim drowsy 60                  # R climbs, tree fires, voice + iMessage on 85
> say I'm fine
```

`sim` streams samples on a fast-forwarded clock, so a minute of driving takes about a second.

## Limits

- Constants (normalizer scales, weights, gains, back-off) are hand-set starting points, not fitted values.
- Hours driving is trip time, not time since the last rest.
- The tree and kids bump run once: `onAlert(..., bumped = true)` skips the orchestrator's own 70 → 85 bump for engine decisions.
