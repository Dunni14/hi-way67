# Phone ↔ backend protocol

**Endpoint:** `ws://<backend-host>:8787/phone` · **Health:** `GET /health`

Every frame is a single JSON object with a `type` field. The source of truth is [`src/ws/protocol.ts`](../backend/src/ws/protocol.ts). [`PROTOCOL.md`](../backend/PROTOCOL.md) in the backend folder is the short version for the Android side.

The backend validates inbound frames with Zod. A frame that is not JSON or fails validation gets an `error` frame back and is otherwise ignored. Fields with defaults can be left out.

There is no authentication. Only one phone connection is kept. A new connection closes the previous one with code `4000`.

## Phone → backend

### `hello`
Send on connect.
```json
{ "type": "hello", "driverName": "Alex", "sharingMode": "high_only", "kidsInCar": false, "shareLocation": true }
```
| Field | Type | Default |
|---|---|---|
| `driverName` | string, optional | keeps `DRIVER_NAME` |
| `sharingMode` | `"always" \| "high_only" \| "never"` | `"high_only"` |
| `kidsInCar` | boolean | `false` |
| `shareLocation` | boolean. `false`: no position ever reaches the iMessage agent (see [gps.md](gps.md#privacy)) | `true` |

### `settings`
Send when a toggle changes. Every field is optional.
```json
{ "type": "settings", "sharingMode": "always", "kidsInCar": true, "shareLocation": false }
```

### `trip_start` / `trip_end`
```json
{ "type": "trip_start" }
```
A `risk_window` received without an active trip starts one automatically. `trip_end` posts the summary, sends arrival pings, clears the speech queue and ends any roast.

### `risk_window`
Send every 10 seconds: one window of **raw** signals. The phone doesn't score anything; the backend's risk engine ([risk-engine.md](risk-engine.md)) scores the window, stores it, decides the tier and acts, then answers with an `evaluation`.
```json
{
  "type": "risk_window",
  "ts": 1759500000000,
  "speed": 68, "lat": 42.2808, "lon": -83.743,
  "events": ["yawn"],
  "signals": {
    "face_visible": true, "heart_rate": 64, "breathing_rate": 10.5,
    "eye_closure_frac": 0.4, "longest_eye_closure_s": 2.2, "yawns": 1,
    "emotion_stress": 0.05, "hard_brakes": 0, "swerves": 0,
    "speed_mph": 68, "speed_limit_mph": 65
  }
}
```
| Field | Type | Notes |
|---|---|---|
| `ts` | number | Epoch ms, **real time**, end of the window. Must be unique per trip (the engine rejects a duplicate). |
| `speed` | number, default `0` | mph. Under 3 mph for a full minute counts as "stopped" for chat answers. |
| `lat`, `lon` | number, optional | Enables maps links for guardians |
| `events` | array, default `[]` | `yawn` (one per yawn), `nod`, `hard_brake`, `swerve`. `hard_brake` pauses speech for 10 s; `yawn` and `nod` feed the roast text and answers. |
| `signals` | object | The engine's `SignalWindow` fields, all optional (leave out what you don't know): `face_visible`, `heart_rate`, `breathing_rate`, `engagement`, `eye_closure_frac` (share of the window with eyes closed), `longest_eye_closure_s` (longest continuous closure; ≥ 1.5 s triggers the microsleep override), `yawns`, `emotion_stress`, `gaze_off_road_s`, `phone_in_hand`, `hard_brakes`, `swerves`, `speed_mph`, `speed_limit_mph`. |

The engine counts windows for its baseline (6), hold (2) and sustained-drowsiness rules (3 and 12), and uses `ts` for cooldowns. Demo mode exploits that: it sends windows faster but stamps them in real time, so alerts come sooner while cooldowns stay at 2 real minutes.

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

### `evaluation`
The engine's verdict on one `risk_window` (same `ts`).
```json
{
  "type": "evaluation", "ts": 1759500000000,
  "score": 22.5, "tier": 2, "dominant": "drowsy",
  "levels": { "drowsy": 0.67, "agitated": 0, "speeding": 0, "phone": 0, "distracted": 0, "erratic": 0 },
  "override": "drowsy_sustained_3", "degraded": false,
  "actions": ["voice_warning"], "calibrating": false
}
```
| Field | Notes |
|---|---|
| `score` | 0–100, from the cited odds-ratio weights. Drowsiness alone tops out around 31; drowsy alerts come from `override`s. |
| `tier` | 0 none · 1 nudge · 2 warning · 3 urgent (after holds, overrides and the kids-in-car raise) |
| `levels` | Each factor 0..1 |
| `override` | Why the tier was forced: `microsleep`, `drowsy_sustained_3`, `drowsy_sustained_12`, `tier2_sustained_12`, or `null` |
| `degraded` | Face hidden for 3+ windows: scored on speed and motion only |
| `actions` | What the backend is doing about it: `voice_nudge`, `voice_warning`, `voice_urgent`, `notify_contacts`, `ask_permission_to_notify`, or `none` |
| `calibrating` | Still inside the engine's 6 baseline windows |

The phone displays it and plays its alarm sound when `actions` contains `voice_urgent`. The backend speaks and notifies on its own.

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
{ "type": "dismissed", "factor": "drowsy", "multiplier": 0.95 }
```
The driver said "I'm fine". The backend recorded it with the engine as a false alarm, which eased `factor`'s weight for this driver to `multiplier` (×0.95 per false alarm, clamped 0.5–1.5) and penalized the bandit's last pick. The phone stops its alarm and shows the change.

### `error`
```json
{ "type": "error", "message": "…" }
```
Log it.

## Example sequences

**Drowsy warning, then "I'm fine"**
```
phone   → risk_window {eye_closure_frac 0.4, breathing_rate 10.5, yawns 1}   (3rd drowsy window in a row)
backend → evaluation {tier 2, override drowsy_sustained_3, actions [voice_warning]}
backend → speak {tier 70, context checkin, listenAfterMs 5000}      (bandit-picked line)
phone   → utterance {"I'm fine", checkin}  → speak_done
backend → dismissed {factor drowsy, multiplier 0.95}, speak {"Okay. I'll back off for now."}
```

**Microsleep**
```
phone   → risk_window {longest_eye_closure_s 2.2, …}
backend → evaluation {tier 3, override microsleep, actions [voice_urgent, notify_contacts]}
phone     plays the alarm sound
backend → speak urgent line; group alert + roast call; location to guardians
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
backend   evaluation {tier 3, dominant drowsy, actions [voice_urgent, notify_contacts]}
backend → speak urgent line
(group)     ⚠️ Alex is at high risk (drowsy). I've told them to pull over.
(guardians) 📍 Alex's location: near State St, Ann Arbor · 58 mph · fix at 5:26 AM + <Apple Maps link>
(group)     🚨 Alex has yawned 3 times … Roast Alex awake!
(group) Sam: "bro is hibernating"
backend → speak {"Sam says: bro is hibernating", roast, 5000}   (priority)
phone   → utterance {"ok ok I'm pulling over", roast}
(group) 🗣️ Alex says: "…" ✅ Alex is talking back, so they're awake.
```
