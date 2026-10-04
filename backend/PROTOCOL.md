# Phone ↔ backend WebSocket protocol

Connect to `ws://<backend-host>:8787/phone`. Every frame is one JSON object with a `type`.
Source of truth: [src/ws/protocol.ts](src/ws/protocol.ts). Health check: `GET /health`.

## Phone → backend

| type | fields | when |
|---|---|---|
| `hello` | `driverName?`, `sharingMode` (`always`/`high_only`/`never`), `kidsInCar` | on connect |
| `settings` | `sharingMode?`, `kidsInCar?` | toggle changed |
| `trip_start` / `trip_end` | none | trip begins / ends |
| `risk_window` | `ts` (epoch ms), `R`, `drowsy`, `reckless` (0–100), `speed` (mph), `lat?`, `lon?`, `events[]` (`yawn`,`nod`,`hard_brake`,`swerve`), `features?` | every 10 s |
| `alert` | `tier` (40/70/85), `dominant` (`drowsy`/`reckless`), `R` | decision tree fires (after the 15 s hold and cooldown) |
| `utterance` | `text`, `context` (copy the `context` of the `speak` you listened after, or `free`) | speech-to-text result |
| `speak_done` | `id` | finished playing a `speak` (and its listen window) |

## Backend → phone

| type | fields | phone should |
|---|---|---|
| `speak` | `id`, `text`, `tier`, `audio` (base64 mp3, may be `""`), `listenAfterMs`, `context` | play `audio` (or on-device TTS of `text` if empty); if `listenAfterMs > 0`, listen that long and send an `utterance` with the same `context`; then send `speak_done` |
| `navigate` | `query` | open maps for "rest stop" |
| `dismissed` | none | driver said "I'm fine": apply the weight nudge |
| `error` | `message` | log it |

The backend handles 85-tier escalation (iMessage alerts and the roast), the kids-in-car bump from 70 to 85, and reading family messages aloud. The phone only reports.

> Risk scoring is moving to the backend ([risk engine](../docs/risk-engine.md)). A raw `SignalWindow` frame will replace `risk_window` / `alert`; it is not in `src/ws/protocol.ts` yet, so keep sending `R`, `tier` and `alert` for now.
