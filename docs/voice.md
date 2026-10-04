# Voice

**Backend: Done.** Playback and speech recognition on the phone: **Not started**.

Code: [`src/voice/`](../backend/src/voice), [`src/agent/driverIntent.ts`](../backend/src/agent/driverIntent.ts).

## ElevenLabs TTS

`tts(text, tier)` calls `POST /v1/text-to-speech/{ELEVENLABS_VOICE_ID}` with `mp3_44100_128` output and a 10 s timeout. It returns an mp3 buffer, which is sent to the phone as base64 inside `speak`.

Every tier uses the same voice. Delivery changes through `voice_settings`. Lower stability and higher style make the voice sound more urgent:

| Tier | Use | stability | similarity_boost | style |
|---|---|---|---|---|
| 0 | Messages, roasts, acks | 0.55 | 0.75 | 0.25 |
| 40 | Calm, warm check-in | 0.65 | 0.75 | 0.20 |
| 70 | Firm warning | 0.45 | 0.80 | 0.50 |
| 85 | Urgent: pull over | 0.25 | 0.85 | 0.85 |

`use_speaker_boost` is always on. `npm run smoke:tts` writes one sample per tier to `out/`.

**Not implemented:** the README's "one loud bundled audio file" alarm stage. Tier 85 uses the urgent TTS voice instead.

## Driver speech queue

[`driverQueue.ts`](../backend/src/voice/driverQueue.ts). Everything said to the driver goes through this queue, one item at a time.

- **Order:** FIFO. `priority: true` items go to the front: all alerts, roast replies, and acks for navigation and permission.
- **One in flight:** the next item is sent when the phone sends `speak_done` for the current `id`, or when a safety timeout fires (`max(2 s, chars/15 s) + listenAfterMs + 3 s`).
- **Hard brake:** a `hard_brake` event pauses delivery for 10 s. The item already playing is not interrupted.
- **TTS failure:** the item is still sent, with `audio: ""`.
- **Phone offline:** the item is dropped and the queue moves on.
- **`trip_end`:** clears queued items.

**Gap vs. README:** at high drowsiness only *roasts* skip the queue. Ordinary family messages are not prioritized.

## Spoken lines

[`lines.ts`](../backend/src/voice/lines.ts). Alert lines are templates, not LLM output, so they are instant and predictable. Each tier and dominant pair has two variants, picked at random.

| Tier | Drowsy (example) | Reckless (example) |
|---|---|---|
| 40 | "Hey, you've been yawning a bit. Want me to find a rest stop?" | "Easy there. Let's ease off the gas a little." |
| 70 | "You're getting drowsy. I'd really like you to stop soon. Should I route you to the nearest rest stop?" | "Slow down. Your driving is getting risky." |
| 85 | "You need to pull over now. You are falling asleep at the wheel." | "Pull over now and take a breath. This is not safe." |

Other lines: `Message from <name>: <body>`, `<name> says: <roast>`, the permission question ("Do you want me to let your family know? Say yes or no."), and acks ("Okay. I'll back off for now.", "Finding the nearest rest stop.", "Sent.", "Okay, I've let them know.", "Okay, I won't tell anyone. Please stay safe.").

Chat text is made sayable by `shortenForSpeech`: whitespace is collapsed and URLs become "a link". Anything over 120 characters is shortened by an LLM to one sentence of at most 20 words, or truncated if the LLM fails.

## When the backend listens

| Speak | `context` | `listenAfterMs` |
|---|---|---|
| 40 / 70 alert, drowsy (always ends in a question, e.g. "How are you feeling?") | `checkin` | 5000 |
| 40 / 70 alert, reckless | `checkin` | 5000 for the default lines and the rest-stop offer, 0 for other bandit lines |
| Urgent check-in after a first microsleep | `checkin` | 5000 |
| 85 alert | `checkin` | 0 |
| Permission question (sharing `never`) | `permission` | 5000 |
| Family message | `after_message` | 5000 |
| Roast | `roast` | 5000 |
| Acks | `info` | 0 |

## Urgent check-in

A first microsleep doesn't sound the alarm. The engine marks it `check_in_urgent` and `orchestrator.ts`:

1. Speaks "Ray! Your eyes just closed for a couple of seconds. Are you with me? Say something." (priority, tier 85, listens 5 s).
2. **Any utterance** before the listen window ends, plus a 1.5 s grace for late speech-to-text, counts as an answer: "Good. Stay with me, and take a break soon." No alarm. A "tell …" in the answer still goes to the group.
3. **No answer:** sends `alarm` to the phone, then runs the usual 85 flow (urgent line, guardian alert, roast).

The answer window starts when the phone sends `speak_done` (or the queue times out, or the phone isn't connected, which escalates to contacts). A second microsleep within 2 minutes alarms straight away. In a `checkin` context, replies other than "tell …" are never posted to the group, which is why drowsy check-ins can always listen.

## Driver intent parsing

Regex only, in [`driverIntent.ts`](../backend/src/agent/driverIntent.ts). Checked in this order:

| Intent | Matches | Example |
|---|---|---|
| `dismiss` | "I'm / I am fine / good / ok / awake / alright", "leave me alone", "stop it" | "I'm fine" |
| `reply` | "tell / text / message / let <someone> (know) (that) …" | "tell her I'm stopping in ten" → "I'm stopping in ten" |
| `yes` | starts with yes / yeah / yep / sure / please / ok / do it / go ahead | "yeah" |
| `no` | starts with no / nope / nah / don't / do not | "nah" |
| `reply` | anything else, when context is `after_message` or `roast` | "lol shut up" |
| `unknown` | everything else | |

Note that "ok" alone matches `yes`, but "I'm ok" matches `dismiss` first.

What the orchestrator does with each intent is in [architecture.md](architecture.md#driver-speech).
