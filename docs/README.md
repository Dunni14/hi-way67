# Driver Guardian documentation

Technical documentation for the code in this repository. The product pitch, track list and demo script live in the [root README](../README.md); these pages describe what is **actually built**, how to run it, and what is still missing.

> **Snapshot:** 2026-10-04. The backend (with the logistic risk engine) and the Android app in `frontend/` are both in the repo. The app compiles and its JVM tests pass, but it has not been run on a device or against a live backend.

## Pages

| Page | What it covers |
|---|---|
| [status.md](status.md) | Feature-by-feature implementation status against the root README, plus known issues |
| [architecture.md](architecture.md) | Components, data flow, who owns which part of the decision tree |
| [backend.md](backend.md) | Setup, environment variables, scripts, module reference |
| [protocol.md](protocol.md) | Phone ↔ backend WebSocket contract, with example frames and sequences |
| [imessage-agent.md](imessage-agent.md) | Photon Spectrum agent: roles, message classification, the four flows, the roast, sharing modes |
| [voice.md](voice.md) | ElevenLabs TTS, tiered delivery, the driver speech queue, spoken lines, driver intent parsing |
| [risk-engine.md](risk-engine.md) | Logistic risk engine: scoring, decision rules, REST API, Postgres storage |
| [phone-app.md](phone-app.md) | The Android app: what it does, who scores, what it sends |
| [persistence.md](persistence.md) | `TripStore` interface, the in-memory stub, and what the Tiger Data implementation must provide |

## Status at a glance

| Area | State |
|---|---|
| Backend server, WebSocket protocol, health check | **Done** |
| Photon iMessage agent (classifier, Q&A, relay, roast, arrival pings) | **Done** |
| ElevenLabs tiered voice and driver speech queue | **Done** (backend side) |
| Dev tools (`fake-phone`, `smoke:tts`) | **Done** |
| Tiger Data persistence | **Stub**: in-memory only, lost on restart |
| Android app (Presage, engine client, fallback scoring, GPS, IMU, alarm, history) | **Built, untested on a device** (`frontend/`). Speech and voice playback excluded. |
| "I'm fine" weight nudge | **Done**: backend sends `dismissed`, the app nudges its local weights; engine trips use feedback buttons |
| Report card and trip history | **Done** in the app (engine part needs Postgres) |
| Pre-trip questionnaire (excluded), weather, real alarm audio, Fetch.ai agent | **Not started** |

See [status.md](status.md) for the full breakdown.

## Repository layout

```
auto-ai/
├── README.md                    Product plan (features, tracks, demo script)
├── docs/                        This documentation
├── frontend/                    Android app (Kotlin, Compose, Presage): see frontend/README.md
└── backend/                     Node / TypeScript backend
    ├── PROTOCOL.md              Short protocol table for the Android teammate
    ├── .env.example             Every environment variable the backend reads
    ├── contacts.example copy.json   Example allowlist (copy to contacts.json)
    └── src/
        ├── index.ts             Boot
        ├── config.ts            Env access
        ├── orchestrator.ts      Phone events + chat messages -> actions
        ├── ws/                  WebSocket server and protocol schema
        ├── trip/                Live trip state and the persistence interface
        ├── agent/               Spectrum connection, classifier, answers, roast, contacts, driver intent
        ├── voice/               ElevenLabs TTS, speech queue, spoken line templates
        ├── risk/                Logistic risk engine, Postgres store (REST: http/risk.ts)
        ├── llm/                 OpenRouter client
        └── dev/                 fake phone and TTS smoke test
```
