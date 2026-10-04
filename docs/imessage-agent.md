# iMessage agent (Photon Spectrum)

**Status: Done**, apart from persistence. Contact preferences and trip history are in memory only; see [persistence.md](persistence.md).

Code: [`src/agent/`](../backend/src/agent), routing in [`src/orchestrator.ts`](../backend/src/orchestrator.ts) (`onChat`).

## Connection

`startSpectrum()` builds a `Spectrum` app with the providers in `SPECTRUM_PROVIDERS`:

- `imessage` (default), the qualifying provider for the Photon track
- `telegram`, optional, for testing. Needs `TELEGRAM_BOT_TOKEN`.

It then loops over `app.messages` and handles inbound messages only. A handler error is logged and does not stop the loop.

### Group chat capture

The agent learns which group is "the family chat" at runtime, or from `GROUP_CHAT_ID`.

- The first group message from an **allowlisted** contact captures that group.
- Anyone sending `/start` (or `/start@YourBot`, which Telegram sends from the command menu) in a group captures it, and the agent replies with a greeting. This command does **not** check the allowlist.
- Telegram groups are detected by a negative chat id.
- Each capture (both ways above) is saved to `backend/.group.json` (gitignored) as `{ platform, id }`.
- At startup, `restoreGroup()` rebinds the group through the provider's `space.get(id)`: from `GROUP_CHAT_ID` (+ `GROUP_CHAT_PLATFORM`, default `telegram`) if set, otherwise from `.group.json`. If that fails, the error is logged and capture works as above. With `GROUP_CHAT_ID` set, a later `/start` elsewhere still updates `.group.json`, but the env var wins on the next restart.

### Adding contacts from the phone app

The allowlist is live: `contacts.ts` keeps it in memory and writes every change back to `CONTACTS_PATH` (temp file, then rename). Without the file, dev mode (everyone is a guardian) lasts until the first contact is added.

- **Telegram:** the app sends `contact_add` with `platform: "telegram"`. The backend creates a 6-character invite code (single use, 15 min, in memory) and returns `contact_invite` with `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code>`. Opening it sends `/start <code>` to the bot in a private chat; the bot adds the sender's numeric id with the name and role from the invite, replies "You're on Alex's road crew 🚗", and sends `contact_joined` to the phone. Their DM space is cached, so `dm()` reaches them right away. A bad or expired code gets a short error reply.
- **iMessage:** not available from the app yet; add the phone number to `contacts.json`.
- Telegram handles are stored raw (`"123456789"`), never normalized like phone numbers, and match only Telegram senders.

See [protocol.md](protocol.md#contact_add) for the frames.

DM spaces are cached per contact as they arrive. When none is cached, `dm()` opens a new DM for iMessage contacts only. Telegram bots can't start a chat, so a Telegram contact is only reachable by DM after they've messaged the bot privately; otherwise `dm()` logs a warning and skips them.

### Posting

| Function | Behavior |
|---|---|
| `post(text)` | Sends to the group. With no group, DMs every allowlisted contact. |
| `post(text, "guardian")` | Always DMs guardians only, even when a group exists. Used for the location link, so it stays away from friends. |
| `dm(handle, text)` | Sends one DM. Errors are logged and swallowed. |

An 85-tier alert posts "⚠️ Alex is at high risk…" to the whole chat and the maps link to guardians only.

### Telegram setup

1. Create the bot with @BotFather and put the token in `TELEGRAM_BOT_TOKEN`; include `telegram` in `SPECTRUM_PROVIDERS`.
2. **Turn privacy mode off:** BotFather → `/setprivacy` → your bot → Disable. Then remove and re-add the bot to the group (the setting applies on join). With privacy on, the bot only sees commands, so roasts and questions never arrive.
3. Start the backend **without** `NO_SPECTRUM`, then send `/start` in the group. The log shows `group chat bound via /start`.
4. Set `TELEGRAM_BOT_USERNAME` and add each person from the app (invite link, see above). Or by hand: have each person write something in the group. Unknown senders are logged with a ready-made line, e.g. `{"handle":"123456789","name":"<name>","role":"friend","platform":"telegram"}`. Paste it into `contacts.json`, set the name and role, and restart.
5. For guardian-only messages (the location link) to reach a Telegram guardian, they must message the bot privately once.

## Roles

| Role | Can ask questions | Gets location | Gets 85-tier alerts | Can message / roast driver |
|---|---|---|---|---|
| Guardian | Yes | Yes (in answers, and the location message at 85), unless the driver turned location sharing off. See [gps.md](gps.md#photon-imessage-agent) | Yes (group alert + location by DM) | Yes |
| Friend | Yes, without location | No | Yes, in the group, without location | Yes |

## Message handling

1. Look up the sender in the allowlist. Unknown senders are ignored.
2. Turn the content into text. Images, videos and files become "Mom sent a photo." (or "video", "file"), rich links become "Mom sent a link.", and reactions, typing indicators and edits are dropped.
3. Classify with an LLM (`MODEL_CLASSIFY`) into one of:

| Kind | Meaning | Action |
|---|---|---|
| `question` | Asks about the driver or trip | Typing indicator, then an LLM answer as a reply |
| `to_driver` | "Tell Alex …" or anything addressed to the driver | Shorten to one line, queue as "Message from Mom: …", listen 5 s, react 👍. With no active trip, replies "Alex isn't driving right now…". |
| `roast_reply` | A roast while a roast round is active | Shorten, queue as **priority** "Sam says: …", listen 5 s, react 😂 |
| `arrival_pref` | "Let me know when he gets there" | Save `notifyOnArrival` for the sender, confirm. On arrival they get a DM, plus the report card image |
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

## Wake-up sound poll

Before things get as far as a roast, the group picks a sound to wake the driver up. State in [`soundPoll.ts`](../backend/src/agent/soundPoll.ts), wired in `orchestrator.ts`.

- **Opens** on an engine evaluation with `dominant: "drowsy"` at tier 1 or 2 (the 40 nudge or 70 warning), when sharing is not `never`, no roast and no poll is running, and no poll started in the last 5 minutes. The tiers are `POLL_TIERS` in `soundPoll.ts`.
- **Posts** with `post()` (DMs if there is no group): `😴 Alex is getting sleepy. Pick their wake-up sound (25s): reply 1 🐓 Rooster · 2 📯 Air horn · 3 🐐 Goat scream`. The ids of the sent messages are kept so reactions to them count.
- **Votes:** a message from an allowlisted contact that is just `1`, `2`, `3` or one of the emoji, or that emoji as a reaction to the poll message. Votes never reach the classifier. One vote per contact; the latest replaces the earlier one. Other reactions are ignored.
- **Closes** after 25 s, or as soon as every allowlisted contact has voted. Most votes wins, a tie is broken at random among the tied, no votes means the air horn. The group gets `🐓 Rooster wins (2 votes). Playing now.` and the phone gets `play_sound`.
- **Escalation wins:** a tier 3 evaluation cancels an open poll silently; the 85 flow (guardian alert, roast) runs as usual. A trip ending also cancels it.

The sounds are listed in [`backend/src/agent/sounds.json`](../backend/src/agent/sounds.json): `id`, `emoji` and `title` per sound (list order is the vote number, up to 9) and the `default` played when nobody votes. It is checked at startup. The phone plays `res/raw/<id>.mp3`, so each id must match a file there (lowercase letters, digits, `_`). Reactions only arrive from Telegram if the bot receives `message_reaction` updates (and in groups only when the bot is an admin), so text replies are the reliable way to vote.

Without Spectrum (`NO_SPECTRUM=1`), `POST /dev/chat` stands in for the group chat; `npm run fake-phone -- --poll` uses it to run the whole poll.

## Sharing modes

| Event | `always` | `high_only` | `never` |
|---|---|---|---|
| Trip start note ("🚗 Alex just started driving", plus the late-night count) | Posted | Not posted | Not posted |
| 40 / 70 alerts | Voice only | Voice only | Voice only |
| 85 alert | Group alert + guardian location DM + roast | Group alert + guardian location DM + roast | Driver asked by voice; yes → same as other modes |
| Answers to questions | Full facts | Full facts only within 15 min of an 85 alert | "Sharing is off" |
| Trip summary on `trip_end` | Posted | Posted | Not posted |
| Arrival DM to contacts who asked | Sent | Sent | **Sent** (known issue: not gated) |

## Persistent context

| Feature | Status |
|---|---|
| "That's the 3rd late-night drive this week" on trip start (22:00–05:00, at least 2 night trips in 7 days, `always` mode only) | Logic done; history is in memory (**stub**) |
| "Mom wants a message when he arrives" (one-shot, cleared after sending) | Logic done; prefs are in memory (**stub**) |
| Trip summary: "🏁 Alex arrived safely. 34 min drive, 2 warnings, peak risk 88/100." | Done |

## Report card image

At trip end, when the risk engine scored the trip and the sharing mode is not `never`, `orchestrator.ts` renders the report card with `report/image.ts` and posts it through `postImage` (`agent/spectrum.ts`): to the family group, or to every contact when no group is bound, using Spectrum's `attachment()` content. Contacts with `notifyOnArrival` also get it through `dmImage`. The group then gets the same few sentences as text (`🏁 …`, from `report/narrative.ts`) so the chat preview says something. If rendering or sending fails, the plain-text summary is posted instead. The image shows score, grade, average and top speed, attention and the category meters, never a location.
