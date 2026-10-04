# Phone ↔ backend WebSocket protocol

Connect to `ws://<backend-host>:8787/phone`. Every frame is one JSON object with a `type`.
Source of truth: [src/ws/protocol.ts](src/ws/protocol.ts). Health check: `GET /health`.

The phone senses and displays; the backend's risk engine (`src/risk`) scores every window and decides every alert.

## Phone → backend

| type | fields | when |
|---|---|---|
| `hello` | `driverName?`, `sharingMode` (`always`/`high_only`/`never`), `kidsInCar`, `shareLocation` (default `true`) | on connect |
| `settings` | `sharingMode?`, `kidsInCar?`, `shareLocation?` | toggle changed |
| `trip_start` / `trip_end` | none | trip begins / ends |
| `risk_window` | `ts` (epoch ms, real time, unique), `speed` (mph), `lat?`, `lon?`, `events[]` (`yawn`,`nod`,`hard_brake`,`swerve`), `signals` (raw, below) | every 10 s (faster in demo mode) |
| `utterance` | `text`, `context` (copy the `context` of the `speak` you listened after, or `free`) | speech-to-text result |
| `speak_done` | `id` | finished playing a `speak` (and its listen window) |
| `contact_add` | `name`, `role` (`guardian`/`friend`), `platform` (`telegram`/`imessage`), `phone?` | add a contact. Telegram: answered with `contact_invite`. iMessage: `error` (not available yet) |
| `contact_remove` | `handle` | remove a contact; answered with `contacts` |
| `contact_update` | `handle`, `role` | guardian switch; answered with `contacts` |
| `contacts_list` | none | answered with `contacts` |

`signals` (all optional; leave out what you don't know): `face_visible`, `heart_rate`, `breathing_rate`, `engagement`, `eye_closure_frac` (share of the window with eyes closed), `longest_eye_closure_s` (longest continuous closure; 1.5 s or more is a microsleep), `yawns`, `emotion_stress`, `gaze_off_road_s`, `phone_in_hand`, `hard_brakes`, `swerves`, `speed_mph`, `speed_limit_mph`.

## Backend → phone

| type | fields | phone should |
|---|---|---|
| `evaluation` | `ts` (of the window), `score` (0–100), `tier` (0–3), `dominant`, `levels` (0–1 per factor), `override`, `degraded`, `actions[]`, `calibrating` | show it; play the alarm when `actions` has `voice_urgent` |
| `speak` | `id`, `text`, `tier`, `audio` (base64 mp3, may be `""`), `listenAfterMs`, `context` | play `audio` (or on-device TTS of `text` if empty); if `listenAfterMs > 0`, listen that long and send an `utterance` with the same `context`; then send `speak_done` |
| `report` | `score`, `grade`, `summary`, `avg_speed_mph`, `top_speed_mph`, `attention_score`, `duration_s`, `distance_mi`, `image` (base64 PNG, may be `""`) | once, after `trip_end`, if the engine scored the trip: show the report the backend generated for friends and family |
| `navigate` | `query` | open maps for "rest stop" |
| `demo_speed` | `mph` | demo control: while in demo mode, report this speed from now on; ignore it otherwise |
| `dismissed` | `factor?`, `multiplier?` | driver said "I'm fine": stop the alarm; the engine eased that factor's weight for this driver |
| `contacts` | `list[]` of `{handle, name, role, platform}`, `groupBound`, `groupLink` (or `null`) | show the allowlist; "Create group" opens `groupLink` |
| `contact_invite` | `name`, `code`, `link` (`https://t.me/<bot>?start=<code>`) | share `link` with the contact; single use, 15 min |
| `contact_joined` | `name`, `role` | the contact opened the link and is allowlisted; refresh with `contacts_list` |
| `error` | `message` | log it |

The backend decides tiers (holds, overrides such as microsleep, cooldowns, kids in car), speaks, notifies contacts and runs the roast. The phone only reports raw signals.

## Demo speed slider

Open `http://<backend-host>:8787/demo` in a browser on any laptop that can reach the backend. Moving the slider sends `POST /demo/speed {"mph": 0..120}`, which the backend passes to the phone as `demo_speed`. A phone that connects later gets the current value after its `hello`. `GET /demo/state` returns `{mph, phoneConnected}`. There is no login; it only affects a phone in demo mode.
