# Driver Guardian documentation

Technical documentation for the code in this repository. The product pitch, track list and demo script live in the [root README](../README.md); these pages describe what is **actually built**, how to run it, and what is still missing.

> **Snapshot:** 2026-10-03, branch `rnoss`. Only the backend exists in the repo. The Android app described in the root README has not been committed yet, so every phone-side feature is listed as **Not started** below.

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
| [gps.md](gps.md) | Phone GPS: payload, speeding and erratic levels, speed limit lookup, trip start/stop, location in Photon and voice, route on the report card, privacy |
| [phone-app.md](phone-app.md) | Specification for the Android app (not started): what it must send and do |
| [persistence.md](persistence.md) | `TripStore` interface, the in-memory stub, and what the Tiger Data implementation must provide |

## Status at a glance

| Area | State |
|---|---|
| Backend server, WebSocket protocol, health check | **Done** |
| Photon iMessage agent (classifier, Q&A, relay, roast, arrival pings) | **Done** |
| ElevenLabs tiered voice and driver speech queue | **Done** (backend side) |
| Dev tools (`fake-phone`, `smoke:tts`) | **Done** |
| Tiger Data persistence | **Stub**: in-memory only, lost on restart |
| Android app (Presage, risk score, decision tree, GPS, STT, audio playback) | **Not started** (not in repo) |
| "I'm fine" weight nudge | **Partial**: backend sends `dismissed`; the nudge itself belongs to the phone |
| Pre-trip check, report card, surroundings/weather, alarm audio, Fetch.ai agent | **Not started** |

See [status.md](status.md) for the full breakdown.

## Repository layout

```
auto-ai/
├── README.md                    Product plan (features, tracks, demo script)
├── docs/                        This documentation
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
        ├── llm/                 OpenRouter client
        └── dev/                 fake phone and TTS smoke test
```
