# Driver Guardian: agent instructions

MHacks 26 project. A phone on the dash watches the driver with Presage, scores drowsiness and recklessness, talks to the driver with ElevenLabs voice, and keeps family in the loop over iMessage (Photon Spectrum), including a group-chat roast when the driver nods off. The product plan is in [`README.md`](README.md); what is actually built is in [`docs/`](docs/README.md).

## Layout

| Folder | What | Instructions |
|---|---|---|
| `android/` | Kotlin app: Presage SDK on the front camera, and eventually scoring, audio and speech | [`android/AGENTS.md`](android/AGENTS.md) |
| `backend/` | Node / TypeScript: phone WebSocket, iMessage agent, ElevenLabs, OpenRouter | [`backend/AGENTS.md`](backend/AGENTS.md) |
| `docs/` | Architecture, protocol, per-component docs, implementation status | none |

Read [`docs/status.md`](docs/status.md) before saying a feature works. The root README describes the plan, not the current state.

## Rules for the whole repo

- **The protocol is shared.** [`backend/src/ws/protocol.ts`](backend/src/ws/protocol.ts) is the contract between the app and the backend. A change to it needs matching changes in the Android client, [`backend/PROTOCOL.md`](backend/PROTOCOL.md) and [`docs/protocol.md`](docs/protocol.md), in the same change.
- **API keys for ElevenLabs, OpenRouter and Spectrum stay on the backend.** Only the Presage key lives on the phone.
- **Keep the docs current.** When you add a feature or change a convention, update the matching page in `docs/` and its row in `docs/status.md`.
- **Commits use Conventional Commits**, scoped by folder where it helps: `feat(android): …`, `fix(backend): …`, `docs: …`.
- **Never read, print or commit secrets:** `backend/.env`, `backend/contacts.json` (real phone numbers), `android/local.properties`. Use the `.example` files for reference.
- **The driver never touches the screen.** Any driver-facing feature has to work by voice.

## Deadline

Submission is noon Sunday. Prefer the simplest change that keeps the demo loop working: camera → score → voice → iMessage.
