# Driver Guardian backend

Node / TypeScript backend for Driver Guardian. It runs the Photon Spectrum iMessage agent, does ElevenLabs voice, and serves the WebSocket the Android app talks to.

## Run

```sh
npm install
cp .env.example .env                              # fill in Spectrum, ElevenLabs, OpenRouter keys
cp "contacts.example copy.json" contacts.json     # edit the allowlist
npm run start                                     # NO_SPECTRUM=1 to skip iMessage
npm run fake-phone                                # in a second terminal: simulate the phone
```

## Docs

- [Full documentation](../docs/README.md)
- [Implementation status and known issues](../docs/status.md)
- [Backend setup, env vars, module reference](../docs/backend.md)
- [Risk engine](../docs/risk-engine.md) (scoring model, tiers, overrides, weights)
- [WebSocket protocol](../docs/protocol.md) (short version: [PROTOCOL.md](PROTOCOL.md))
