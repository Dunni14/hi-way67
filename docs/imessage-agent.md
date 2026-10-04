# iMessage agent (Photon Spectrum)

**Status: Done**, apart from persistence. Contact preferences and trip history are in memory only; see [persistence.md](persistence.md).

Code: [`src/agent/`](../backend/src/agent), routing in [`src/orchestrator.ts`](../backend/src/orchestrator.ts) (`onChat`).

## Connection

`startSpectrum()` builds a `Spectrum` app with the providers in `SPECTRUM_PROVIDERS`:

- `imessage` (default), the qualifying provider for the Photon track
- `telegram`, optional, for testing. Needs `TELEGRAM_BOT_TOKEN`.

It then loops over `app.messages` and handles inbound messages only. A handler error is logged and does not stop the loop.

### Group chat capture

The agent learns which group is "the family chat" at runtime. Nothing is configured.

- The first group message from an **allowlisted** contact captures that group.
- Anyone sending `/start` in a group captures it, and the agent replies with a greeting. This command does **not** check the allowlist.
- Telegram groups are detected by a negative chat id.
- The capture lives in memory. After a restart, someone has to post in the group again.

DM spaces are cached per contact as they arrive. `dm()` creates a new iMessage DM when none is cached. This is iMessage only, so DMs fail under a Telegram-only setup.

### Posting

| Function | Behavior |
|---|---|
| `post(text)` | Sends to the group. With no group, DMs every allowlisted contact. |
| `post(text, "guardian")` | Always DMs guardians only, even when a group exists. This keeps location away from friends. |
| `dm(handle, text)` | Sends one DM. Errors are logged and swallowed. |

## Roles

| Role | Can ask questions | Gets location | Gets 85-tier alerts | Can message / roast driver |
|---|---|---|---|---|
| Guardian | Yes | Yes (in answers and alerts), unless the driver turned location sharing off. See [gps.md](gps.md#photon-imessage-agent) | Yes, by DM | Yes |
| Friend | Yes, without location | No | No (sees only the roast call in the group) | Yes |

## Message handling

1. Look up the sender in the allowlist. Unknown senders are ignored.
2. Turn the content into text. Images, videos and files become "Mom sent a photo." (or "video", "file"), rich links become "Mom sent a link.", and reactions, typing indicators and edits are dropped.
3. Classify with an LLM (`MODEL_CLASSIFY`) into one of:

| Kind | Meaning | Action |
|---|---|---|
| `question` | Asks about the driver or trip | Typing indicator, then an LLM answer as a reply |
| `to_driver` | "Tell Alex …" or anything addressed to the driver | Shorten to one line, queue as "Message from Mom: …", listen 5 s, react 👍. With no active trip, replies "Alex isn't driving right now…". |
| `roast_reply` | A roast while a roast round is active | Shorten, queue as **priority** "Sam says: …", listen 5 s, react 😂 |
| `arrival_pref` | "Let me know when he gets there" | Save `notifyOnArrival` for the sender, confirm |
| `chatter` | People talking among themselves | Stay silent |

A `roast_reply` outside a roast round is downgraded to `to_driver`.

**Keyword fallback** when the LLM fails, checked in this order:
1. "let me know / tell me / text me / message me … arrive / get there / home" → `arrival_pref`
2. starts with "tell <driver>" → `to_driver`, with the prefix stripped
3. ends in `?` or starts with where / how / has / is / did / when / what → `question`
4. roast active → `roast_reply`
5. mentions the driver's name, or is a DM → `to_driver`
6. otherwise → `chatter`

## Answering questions (flow 1)

`tripFacts(role)` builds a fact list **before** the LLM sees anything, so the model cannot leak what it was never given:

| Situation | Facts given |
|---|---|
| No trip | "Alex is not on a drive right now." |
| Sharing `never` | "Alex has trip sharing turned off." |
| Sharing `high_only`, no 85 alert in the last 15 min | "Alex is driving" and "everything looks fine" |
| Otherwise | Minutes driving; stopped or current speed; current R with a label (fine / a bit tired / high); yawns in the last 10 min; time and type of the last warning; maps link for **guardians only** |

The answer model (`MODEL_ANSWER`) replies in 1–2 texting sentences using only those facts. If the LLM call fails, the facts are sent as plain text.

## The roast (flow 4)

State machine in [`roast.ts`](../backend/src/agent/roast.ts):

```
idle ──(85 drowsy alert, sharing allows)──► active (3 min window)
active ──roast_reply──► heardOne
heardOne ──any driver utterance──► idle  +  "✅ Alex is talking back, so they're awake."
active ──"I'm fine"──► idle
active ──3 min elapse / trip_end──► idle
```

Roast call text, built from the last 4 minutes of windows:

> 🚨 Alex has yawned 3 times and nodded off 1 time in the last 4 minutes at 68 mph. Roast Alex awake! Reply here and I'll read it out loud.

With no yawns or nods: "Alex is getting dangerously drowsy". The speed is omitted at 5 mph or below.

Only a **drowsy** 85 starts a roast. A **reckless** 85 alerts guardians and nothing more.

## Sharing modes

| Event | `always` | `high_only` | `never` |
|---|---|---|---|
| Trip start note ("🚗 Alex just started driving", plus the late-night count) | Posted | Not posted | Not posted |
| 40 / 70 alerts | Voice only | Voice only | Voice only |
| 85 alert | Guardian DM + roast | Guardian DM + roast | Driver asked by voice; yes → same as other modes |
| Answers to questions | Full facts | Full facts only within 15 min of an 85 alert | "Sharing is off" |
| Trip summary on `trip_end` | Posted | Posted | Not posted |
| Arrival DM to contacts who asked | Sent | Sent | **Sent** (known issue: not gated) |

## Persistent context

| Feature | Status |
|---|---|
| "That's the 3rd late-night drive this week" on trip start (22:00–05:00, at least 2 night trips in 7 days, `always` mode only) | Logic done; history is in memory (**stub**) |
| "Mom wants a message when he arrives" (one-shot, cleared after sending) | Logic done; prefs are in memory (**stub**) |
| Trip summary: "🏁 Alex arrived safely. 34 min drive, 2 warnings, peak risk 88/100." | Done |
