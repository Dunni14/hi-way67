# Driver Guardian backend: agent instructions

Node / TypeScript backend for Driver Guardian (MHacks 26). It talks to the Android app over a WebSocket, runs an iMessage agent through [Photon Spectrum](https://photon.codes/docs/spectrum-ts) (`spectrum-ts@^12.10.1`), and makes the ElevenLabs and OpenRouter calls. Full docs live in [`../docs/`](../docs/README.md). Read [`../docs/status.md`](../docs/status.md) before claiming something is implemented.

## Layout

- `src/index.ts`: boot (store → orchestrator → WebSocket server → Spectrum).
- `src/orchestrator.ts`: all routing between phone frames, chat messages, voice and posts. Most behavior changes start here.
- `src/ws/protocol.ts`: **source of truth** for the phone protocol. If you change it, update `PROTOCOL.md` and `../docs/protocol.md` in the same change.
- `src/agent/`: Spectrum connection (`spectrum.ts`), classifier, answers, roast, contacts allowlist, driver intent regexes.
- `src/voice/`: ElevenLabs TTS, the one-at-a-time driver speech queue, spoken line templates.
- `src/risk/`: risk engine (levels → logistic score → tier → actions). Pure functions; every weight and threshold is in `weights.json`. Not yet called by the orchestrator. See `../docs/risk-engine.md`.
- `src/trip/`: live trip state, and the `TripStore` interface. The only implementation is in-memory; Tiger Data is a TODO.
- `src/llm/openrouter.ts`: LLM client. Every LLM call has a non-LLM fallback. Keep it that way so the demo never stalls.
- `src/dev/`: `fakePhone.ts` (simulates the Android app) and `smokeTts.ts`.

There is no Android code in this repo. Presage sensing belongs to the phone. Risk scoring and the decision tree (hold, cooldown, overrides) are implemented in `src/risk/`, but the live orchestrator does not call them yet: it still trusts `R`, `tier` and `alert` frames from the phone. Do not apply the kids-in-car bump in both places once the engine is wired in.

## Commands

- `npm run dev`: start with watch. `npm run start` starts without it.
- `NO_SPECTRUM=1 npm run dev`: phone side only, no iMessage.
- `npm run fake-phone` runs the scripted demo. Add `-- -i` for interactive mode (`win`, `alert`, `say`, …; see `../docs/backend.md`).
- `npm run smoke:tts`: writes one mp3 per voice tier to `out/`.
- `npm run typecheck`: run this after every change.
- `npm run test`: risk engine tests (`src/risk/*.test.ts`). Run after touching `src/risk/` or `weights.json`.

TypeScript runs straight from source with `tsx`, so there is no build step. Imports use explicit `.ts` extensions (`verbatimModuleSyntax`, `allowImportingTsExtensions`). `noUncheckedIndexedAccess` is on.

## Conventions

- Alert lines are templates in `voice/lines.ts`, not LLM output, so they are instant and predictable.
- Anything spoken to the driver goes through `driverQueue.enqueue()`. Never send `speak` directly.
- Never send location to friends: `answer.ts` filters facts by role before the LLM sees them, and guardian alerts use `post(text, "guardian")`.
- Mid-tier (40/70) events are voice only. Never post them to the group chat.
- Commits use Conventional Commits (`feat(backend): …`, `fix: …`, `docs: …`).
- Risk logic changes go in `weights.json` or `src/risk/`, never in the orchestrator. Update `../docs/risk-engine.md` (formulas and constants) in the same change.
- Always update the docs when introducing new features, or changing conventions.

## Environment and secrets

Secrets live in `.env` and the contact allowlist in `contacts.json`, both gitignored. **Do not read, write, or echo `.env` or `contacts.json`.** They contain credentials and real phone numbers. Use `.env.example` and `contacts.example copy.json` for reference.

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
