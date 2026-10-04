# Driver Guardian backend: agent instructions

Node / TypeScript backend for Driver Guardian (MHacks 26). It talks to the Android app over a WebSocket, runs an iMessage agent through [Photon Spectrum](https://photon.codes/docs/spectrum-ts) (`spectrum-ts@^12.10.1`), and makes the ElevenLabs and OpenRouter calls. Repo-wide rules (commits, docs, secrets, the shared protocol) are in [`../AGENTS.md`](../AGENTS.md). Component docs: [`../docs/backend.md`](../docs/backend.md).

## Layout

- `src/index.ts`: boot (store → orchestrator → WebSocket server → Spectrum).
- `src/orchestrator.ts`: all routing between phone frames, chat messages, voice and posts. Most behavior changes start here.
- `src/ws/protocol.ts`: **source of truth** for the phone protocol. A change here also needs the Android client, `PROTOCOL.md` and `../docs/protocol.md` updated in the same change.
- `src/agent/`: Spectrum connection (`spectrum.ts`), classifier, answers, roast, contacts allowlist, driver intent regexes.
- `src/voice/`: ElevenLabs TTS, the one-at-a-time driver speech queue, spoken line templates.
- `src/risk/`: logistic risk engine (pure core, service, Postgres store). `src/http/risk.ts`: its REST routes.
- `src/report/`: the report card as a PNG (satori + resvg), sent as an attachment at trip end and served at `GET /trips/{id}/card.png`.
- `src/bandit/`: adaptive recommendations (LinUCB over the tier the risk engine chose; pure math, service, Tiger Data store; config in `bandit.json`). Needs `TIGER_DATABASE_URL`. Never touches tiers or cooldowns.
- `src/gps/`: phone GPS. Pure features, trip start/stop, Overpass speed limit and rest stop lookups, reverse geocoding, location text, card route. Scored in `risk/service.ts`. See [`../docs/gps.md`](../docs/gps.md).
- `src/trip/`: live trip state, and the `TripStore` interface. The only implementation is in-memory; Tiger Data is a TODO.
- `src/llm/openrouter.ts`: LLM client. Every LLM call has a non-LLM fallback. Keep it that way so the demo never stalls.
- `src/dev/`: `fakePhone.ts` (simulates the Android app), `smokeTts.ts`, and `fakeDb.ts` (seeded PGlite stand-in for Tiger).

The risk engine (`src/risk/`) is the only scorer. The phone sends raw-signal `risk_window` frames over the WebSocket; `orchestrator.ts` feeds each into `RiskService.ingestWindow`, whose hook (`onRiskEvaluation`) speaks and notifies, and sends the `evaluation` back to the phone. The same engine is also exposed as a REST API (`src/http/risk.ts`). It always runs: on `DATABASE_URL` (Tiger Data), or the seeded in-process fake database when that is unset. See [`../docs/risk-engine.md`](../docs/risk-engine.md). Presage runs on the phone. `npm run fake-phone` and `npx tsx src/dev/replayDemo.ts` exercise the engine without the app.

## Commands

- `npm run dev`: start with watch. `npm run start` starts without it.
- `NO_SPECTRUM=1 npm run dev`: phone side only, no iMessage.
- `npm run fake-phone` runs the scripted demo. Add `-- -i` for interactive mode (`win`, `alert`, `say`, …; see `../docs/backend.md`).
- `npm run smoke:tts`: writes one mp3 per voice tier to `out/`.
- `TIGER_DATABASE_URL=… npm run smoke:tiger`: end-to-end check against a real Tiger Data instance (creates tables, runs one throwaway trip through the engine and bandit, deletes its rows). See `.env.example` for the TLS note.
- `npm run typecheck`: run this after every change.
- `npm run dev:fake`: risk REST API on a seeded in-process Postgres (no Tiger, no `DATABASE_URL`). `npm run seed:fake` prints what it holds.
- `npm test`: risk engine and GPS unit, HTTP and replay tests (in-process Postgres via PGlite, no server needed). `npx tsx src/dev/makeDrive.ts` regenerates the synthetic GPX drive.

TypeScript runs straight from source with `tsx`, so there is no build step. Imports use explicit `.ts` extensions (`verbatimModuleSyntax`, `allowImportingTsExtensions`). `noUncheckedIndexedAccess` is on.

## Conventions

- Alert lines are templates in `voice/lines.ts`, not LLM output, so they are instant and predictable.
- Anything spoken to the driver goes through `driverQueue.enqueue()`. Never send `speak` directly.
- Location reaches Photon only through `trip.mapsLink()` / `locationText()` / `endLocationText()` in `trip/state.ts`: they return nothing when the driver turned location sharing off. Never read `trip.lastFix` for a Photon message directly.
- Never block scoring on the network: `SpeedLimitProvider.lookup` answers from cache or the last known limit, and fetches in the background.
- Never send location to friends: `answer.ts` filters facts by role before the LLM sees them, and guardian alerts use `post(text, "guardian")`.
- Mid-tier (40/70) events are voice only. Never post them to the group chat.

## Environment and secrets

Secrets live in `.env` and the contact allowlist in `contacts.json`. Both are gitignored and off-limits (see the root rules). Use `.env.example` and `contacts.example copy.json` for reference.

If startup fails with a Spectrum authentication error, tell the user to check `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` (`PROJECT_ID` / `PROJECT_SECRET` also work) at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

Use the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills) for SDK details (message content builders, spaces, providers). If your agent doesn't auto-discover it:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

To manage the Spectrum Cloud project (auth, secret rotation, lines), use the `photon-cli` skill:

```sh
npx skills add photon-hq/skills --skill photon-cli --agent <your-agent>
```

- `photon whoami`: check you're authenticated (`photon login` if not).
- `photon projects regenerate-secret`: rotate the secret, then update `.env`.
- `photon spectrum lines list`: list the lines the app sends from.
- `photon projects show`: inspect the active project.

Use `--agent '*'` to install a skill for every supported agent.
