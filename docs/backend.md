# Backend

Node / TypeScript service in [`backend/`](../backend). Runs with `tsx` directly from source. There is no build step and no `dist/`.

## Requirements

- Node 22+ (scripts use `--env-file-if-exists`).
- A Photon Spectrum Cloud project with an iMessage line ([dashboard](https://app.photon.codes)).
- API keys: ElevenLabs, OpenRouter. Both are optional for booting. When one is missing, the feature that needs it falls back (see [Degraded modes](#degraded-modes)).

## Setup

```sh
cd backend
npm install
cp .env.example .env                              # then fill in the keys
cp "contacts.example copy.json" contacts.json     # then edit the allowlist
npm run start
```

`.env` and `contacts.json` are gitignored.

## Scripts

| Script | What it does |
|---|---|
| `npm run start` | Start the server and the Spectrum agent |
| `npm run dev` | Same, restarting on file changes |
| `npm run fake-phone` | Connect as a fake phone and run the scripted demo (see below) |
| `npm run fake-phone -- -i` | Interactive fake phone |
| `npm run fake-phone -- --contacts` | Send `contacts_list`, `contact_add` (Telegram, then iMessage) and `contacts_list` again, print the replies, exit |
| `npm run smoke:tts` | Write `out/tts-{0,40,70,85}.mp3`, one per voice tier |
| `npm run typecheck` | `tsc --noEmit` |

Set `NO_SPECTRUM=1` to run only the phone side (voice and protocol testing without iMessage).

## Environment variables

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `SPECTRUM_PROJECT_ID` (or `PROJECT_ID`) | none | Unless `NO_SPECTRUM` | Photon project |
| `SPECTRUM_PROJECT_SECRET` (or `PROJECT_SECRET`) | none | Unless `NO_SPECTRUM` | Photon secret |
| `SPECTRUM_PROVIDERS` | `imessage` | No | Comma list: `imessage`, `telegram` |
| `TELEGRAM_BOT_TOKEN` | none | If `telegram` is enabled | From @BotFather |
| `TELEGRAM_BOT_USERNAME` | none | For app contact invites | Bot username (with or without `@`), used in `https://t.me/<username>?start=<code>` |
| `GROUP_CHAT_ID` | none | No | Group chat to bind at startup. Unset = `.group.json` from the last capture |
| `GROUP_CHAT_PLATFORM` | `telegram` | No | Platform of `GROUP_CHAT_ID`: `telegram` or `imessage` |
| `ELEVENLABS_API_KEY` | none | For audio | TTS |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | No | Voice used for every tier |
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` | No | TTS model |
| `OPENROUTER_API_KEY` | none | For LLM features | Classifier, answers, shortening |
| `MODEL_CLASSIFY` / `MODEL_ANSWER` / `MODEL_SHORTEN` | `anthropic/claude-haiku-4.5` | No | OpenRouter model slug per job |
| `PORT` | `8787` | No | HTTP + WebSocket port |
| `OVERPASS_URLS` | `overpass-api.de`, `overpass.openstreetmap.fr` | No | Comma list of Overpass endpoints for posted speed limits and rest stops, tried in order. See [gps.md](gps.md) |
| `GEOCODER_URL` | Nominatim `/reverse` | No | Reverse geocoder for the road and city in guardian location text |
| `DRIVER_NAME` | `Alex` | No | Default driver name. The phone's `hello` can override it in trip state, but LLM prompts still use this value (see [status.md](status.md#known-issues-and-gaps)). |
| `CONTACTS_PATH` | `contacts.json` | No | Allowlist file |
| `NO_SPECTRUM` | unset | No | Skip the Spectrum connection |
| `PHONE_WS_URL` | `ws://localhost:$PORT/phone` | No | Used by `fake-phone` only |

## Contacts allowlist

```json
[
  { "handle": "+15551234567", "name": "Mom", "role": "guardian" },
  { "handle": "friend@icloud.com", "name": "Sam", "role": "friend" }
]
```

- `handle` is whatever Spectrum reports as `sender.id`: an E.164 phone number or an iMessage email. Handles are normalized: lowercase, digits only, and a bare 10-digit number gets `+1`.
- `role` is `guardian` (alerts, location) or `friend` (can message and roast, no location).
- Senders not on the list are ignored.
- **If the file is missing**, the backend runs in dev mode and every sender is treated as a guardian.

## Health check

`GET /health` returns:

```json
{
  "ok": true,
  "phoneConnected": true,
  "tripActive": true,
  "sharingMode": "always",
  "latestR": 42,
  "roastActive": false,
  "queued": 0,
  "groupChatKnown": true
}
```

## Degraded modes

The backend should keep the demo running when one service is down:

| Missing / failing | Behavior |
|---|---|
| ElevenLabs | `speak` frames are sent with `audio: ""`. The phone should fall back to on-device TTS. |
| OpenRouter, classifier | Keyword fallback in `classifier.ts` |
| OpenRouter, answers | The raw fact list is sent as the reply |
| OpenRouter, shortening | Truncated to 117 characters + "..." |
| Phone not connected | `speak` frames are dropped and logged; the queue moves on |
| No group chat captured | Posts fan out as DMs to allowlisted contacts |
| No group and no contacts file | Posts are logged and not sent |
| Spectrum | Set `NO_SPECTRUM=1`; chat features are disabled |

## Testing without the Android app

`npm run fake-phone` connects to the backend as the phone and runs this script:

1. `hello` (Alex, sharing `always`, no kids), then `trip_start`.
2. Three low windows (R = 20), then a yawn window at R = 45 and a 40-tier drowsy `alert`.
3. Says "I'm fine" in the `checkin` context.
4. Two high windows with yawns and a nod, then an 85-tier drowsy `alert`, which starts the roast.

Then roast from the group chat and listen to `out/speak-N.mp3`.

Interactive mode (`-i`) commands:

```
start | end | win <calm|drowsy|micro|angry> [count] | say <text> [as <context>]
share <always|high_only|never> | kids <on|off>
contacts | add <telegram|imessage> <name> [guardian|friend] [phone] | rm <handle> | quit
```

The fake phone acks every `speak` with `speak_done` after 500 ms and saves its audio to `out/`. `say` without `as` reuses the context of the last `speak` that asked to listen.

## Module reference

| File | Responsibility |
|---|---|
| `src/index.ts` | Boot: store → orchestrator → WebSocket server → Spectrum |
| `src/config.ts` | Env access. Optional keys are read lazily so the app boots without them. Roast window: 3 min. |
| `src/orchestrator.ts` | All routing: phone frames, alerts, utterances, chat messages, trip start and end |
| `src/ws/protocol.ts` | Zod schema for phone → backend frames, TS type for backend → phone |
| `src/ws/server.ts` | HTTP + WebSocket server. One phone at a time; a new connection closes the old one (code 4000). |
| `src/trip/state.ts` | `TripState` singleton: current trip, rolling 30 min of windows, event counts, "stopped" check, maps link |
| `src/trip/store.ts` | `TripStore` interface + `InMemoryTripStore` (**stub**) |
| `src/agent/spectrum.ts` | Spectrum connection, inbound routing, group capture, `post()` and `dm()` |
| `src/agent/contacts.ts` | Allowlist load, handle normalization, lookup |
| `src/agent/classifier.ts` | LLM message classifier + keyword fallback; `shortenForSpeech` |
| `src/agent/answer.ts` | Role- and sharing-filtered trip facts → LLM answer |
| `src/agent/roast.ts` | Roast round state and the roast call text |
| `src/agent/driverIntent.ts` | Regex parse of driver speech: dismiss / yes / no / reply / unknown |
| `src/voice/elevenlabs.ts` | TTS call with per-tier voice settings |
| `src/voice/driverQueue.ts` | One-at-a-time speech queue with priority and hard-brake pause |
| `src/voice/lines.ts` | Spoken line templates |
| `src/llm/openrouter.ts` | Minimal chat-completions client, 8 s timeout, JSON extraction helper |
| `src/dev/fakePhone.ts` | Fake Android client |
| `src/dev/smokeTts.ts` | TTS tier smoke test |
