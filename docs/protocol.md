# Phone ↔ backend protocol

**Endpoint:** `ws://<backend-host>:8787/phone` · **Health:** `GET /health`

Every frame is a single JSON object with a `type` field. The source of truth is [`src/ws/protocol.ts`](../backend/src/ws/protocol.ts). [`PROTOCOL.md`](../backend/PROTOCOL.md) in the backend folder is the short version for the Android side.

The backend validates inbound frames with Zod. A frame that is not JSON or fails validation gets an `error` frame back and is otherwise ignored. Fields with defaults can be left out.

There is no authentication. Only one phone connection is kept. A new connection closes the previous one with code `4000`.

## Phone → backend

### `hello`
Send on connect.
```json
{ "type": "hello", "driverName": "Alex", "sharingMode": "high_only", "kidsInCar": false }
```
| Field | Type | Default |
|---|---|---|
| `driverName` | string, optional | keeps `DRIVER_NAME` |
| `sharingMode` | `"always" \| "high_only" \| "never"` | `"high_only"` |
| `kidsInCar` | boolean | `false` |

### `settings`
Send when a toggle changes. Every field is optional.
```json
{ "type": "settings", "sharingMode": "always", "kidsInCar": true }
```

### `trip_start` / `trip_end`
```json
{ "type": "trip_start" }
```
A `risk_window` received without an active trip starts one automatically. `trip_end` posts the summary, sends arrival pings, clears the speech queue and ends any roast.

### `risk_window`
Send every 10 seconds.
```json
{
  "type": "risk_window",
  "ts": 1759500000000,
  "R": 47.5, "drowsy": 61, "reckless": 12,
  "speed": 68, "lat": 42.2808, "lon": -83.743,
  "events": ["yawn"],
  "features": { "eye_closure": 0.31, "long_blinks": 0.2 }
}
```
| Field | Type | Notes |
|---|---|---|
| `ts` | number | Epoch ms, end of the window |
| `R` | number | Combined risk 0–100 |
| `drowsy`, `reckless` | number | Sub-scores 0–100 |
| `speed` | number, default `0` | mph. Under 3 mph for a full minute counts as "stopped". |
| `lat`, `lon` | number, optional | Enables maps links for guardians |
| `events` | array, default `[]` | `yawn`, `nod`, `hard_brake`, `swerve`. `hard_brake` pauses speech for 10 s. `yawn` and `nod` feed the roast text and answers. |
| `features` | `{string: number}`, optional | Stored as-is, not interpreted |

### `alert`
Send when the phone's decision tree fires, after its 15 s hold and cooldown.
```json
{ "type": "alert", "tier": 70, "dominant": "drowsy", "R": 74 }
```
`tier` is `40`, `70` or `85`; `dominant` is `drowsy` or `reckless`.

### `utterance`
A speech-to-text result.
```json
{ "type": "utterance", "text": "tell her I'm stopping in ten", "context": "after_message" }
```
`context` is the `context` of the `speak` the phone was listening after: `checkin`, `after_message`, `permission` or `roast`. Use `free` (the default) for push-to-talk.

### `speak_done`
Send when a `speak` has finished playing, including its listen window.
```json
{ "type": "speak_done", "id": "c0a8…" }
```
If this never arrives, the backend times out and moves on after `text.length / 15` seconds (minimum 2 s), plus `listenAfterMs`, plus 3 s.

## Backend → phone

### `speak`
```json
{
  "type": "speak", "id": "c0a8…",
  "text": "You're getting drowsy. …",
  "tier": 70,
  "audio": "<base64 mp3>",
  "listenAfterMs": 5000,
  "context": "checkin"
}
```
The phone should:
1. Play `audio`. If it is `""` (TTS failed), speak `text` with on-device TTS.
2. If `listenAfterMs > 0`, listen that long and send an `utterance` with the same `context`.
3. Send `speak_done` with the same `id`.

`tier` is `0` for neutral speech (messages, acks). `context` can also be `info`, which never asks the phone to listen.

### `navigate`
```json
{ "type": "navigate", "query": "rest stop" }
```
Open the maps app searching for `query`.

### `dismissed`
```json
{ "type": "dismissed" }
```
The driver said "I'm fine". Apply the weight nudge to the latest window.

### `error`
```json
{ "type": "error", "message": "…" }
```
Log it.

## Example sequences

**Check-in accepted**
```
phone   → alert {tier 40, drowsy}
backend → speak {tier 40, context checkin, listenAfterMs 5000}
phone   → utterance {"yes", checkin}  → speak_done
backend → navigate {"rest stop"}, speak {"Finding the nearest rest stop."}
```

**Family message with reply**
```
(group) Mom: "tell Alex grab coffee at the next exit"
backend → speak {"Message from Mom: grab coffee at the next exit", after_message, 5000}
phone   → utterance {"tell her I'm stopping in ten", after_message}
(group) 🗣️ Alex says: "I'm stopping in ten"
backend → speak {"Sent."}
```

**Roast**
```
phone   → alert {tier 85, drowsy}       (sharing always / high_only)
backend → speak urgent line
(guardians) ⚠️ Alex is at high risk (drowsy)… Location: <maps link>
(group)     🚨 Alex has yawned 3 times … Roast Alex awake!
(group) Sam: "bro is hibernating"
backend → speak {"Sam says: bro is hibernating", roast, 5000}   (priority)
phone   → utterance {"ok ok I'm pulling over", roast}
(group) 🗣️ Alex says: "…" ✅ Alex is talking back, so they're awake.
```
