# Risk model (backend)

Code: `backend/src/risk/`. Tests: `npm test` in `backend/`.

| File | Role |
|---|---|
| `features.ts` | Feature vector `x` (10 entries, 0..1) and `normalize()` from raw Presage / sensor readings. `engagement` is an engagement *deficit* (1 − engagement). |
| `model.ts` | `r = w·x`, `m = 1 + c·k`, `R = clamp(100·r·m)`. Two weight vectors (drowsy, reckless) over the same `x`; `R = max`, `dominant = argmax`. Hand-set `DEFAULT_WEIGHTS`. |
| `fit.ts` | Least squares `w = (XᵀX)⁻¹Xᵀy` (tiny ridge by default so few/collinear rows stay solvable; `ridge: 0` is the textbook form). Weights clipped ≥ 0. |
| `adapt.ts` | Per-driver gradient step on the sub-score that fired: dismissed lowers it, confirmed raises it. |
| `decision.ts` | Decision tree, 15 s hold, 2 min per-tier cooldown, kids bump 70 → 85, 70+ for 2 min → 85, notify vs ask-permission. |
| `engine.ts` | `RiskEngine`: features in, `{score, decision}` out; `feedback()`, `refit()`. |
| `ports.ts` | Seams for future work: `FeatureSource` (pull), `LabelSource` (landing-page habit answers), `WeightStore` (Tiger Data). In-memory / no-op defaults. |

## Wire-up

The phone can send a `feature_window` frame (normalized `features` or `raw` readings, plus `speed`, `lat/lon`, `events`). The orchestrator scores it, stores the window, and routes any `Decision` through the existing `onAlert` path (voice, iMessage, permission ask). "I'm fine" calls `engine.feedback("dismissed")`; "yes" to a check-in calls `"confirmed"`. Legacy `risk_window` / `alert` frames still work. `hello` / `settings` accept `lowExperience`.

## Choices to review

- Each window is assumed to cover the 10 s before its `ts`, so two consecutive windows satisfy the 15 s hold.
- A lower tier is suppressed while a higher tier is in cooldown (no 85 → 70 chatter).
- Context constants `CONTEXT_K` (kids 0.25, low experience 0.15) and the default weights are placeholders to tune.
