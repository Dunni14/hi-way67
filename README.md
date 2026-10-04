# auto-ai
An AI driving partner

# Driver Guardian (working title)

A phone on the dash that watches the driver, scores drowsiness and recklessness in real time, talks to the driver by voice, and keeps family and friends in the loop over iMessage. When the driver starts nodding off, the agent asks the group chat to roast them awake, and the phone reads the roasts out loud.

Built for MHacks 26. Submission deadline: noon Sunday.

## Tracks we are targeting

| Track | Prize | What they want | What we give them |
|---|---|---|---|
| MHacks: Actually Intelligent (AI) | $2,500 | Strong AI project | Live risk model, voice agent and chat agent working together |
| MHacks Grand Prize | $5,000 | Best overall | The roast demo plus real engineering underneath |
| Agents in iMessage using Photon | $400 cash, $300 credits, interview fast-track | Agent in iMessage via Spectrum that understands social context and persists context | Two-way family group chat agent: answers questions, relays messages, runs the roast |
| Best Project Built with ElevenLabs | 3 months Scale tier per member | Best use of ElevenLabs | Hands-free voice that warns, reads family messages and listens for replies |
| MLH: ElevenLabs | Wireless earbuds | Natural, emotionally expressive voice | Voice delivery escalates with risk tier |
| MLH: Presage | Fitbit Inspire and credits | Human Sensing Layer used to read physical and emotional state | Eyes, vitals and expression drive the whole risk score |
| MLH: Tiger Data | Stream Deck Mini | Real-time time-series data | Every 10 second risk window is stored; powers the report card and the agent's memory |
| Notability | 1 year Pro and merch | Use Notability Pro during the hackathon | Our brainstorm notes; 2 screenshots in the Devpost |
| Fetch.ai ASI:One (optional) | $1,250 / $750 / $500 | Agent on Agentverse, discoverable via ASI:One | Only if someone has spare hours: "check on Alex's drive" agent reusing our backend |

Dropped: SpaceX (theme is space data, needs Cursor plus Grok, prize is an $80 keyboard), FinchNode (wants a healthcare app), Neon (Tiger Data fits trip telemetry better).

Photon qualification rule: the agent must be connected to iMessage through Photon's Spectrum framework. Do this first, not last.

## Scope for tonight

| Must ship | Stretch | Cut |
|---|---|---|
| Presage drowsiness score with hand-set weights | GPS speed and weather | Health Connect / Apple Health import |
| Decision tree wired to ElevenLabs voice by tier | Pre-trip self-report screen | Landing page |
| Two-way Photon agent with the roast | Report card with a line chart | Least-squares weight fitting |
| "I'm fine" dismissal that nudges the weights | Hard braking and swerves from phone sensors | Rear camera YOLO, voice cloning, event map, Spotify |
| Trip windows stored in Tiger Data | Fetch.ai agent | |

Rule: the core loop (camera to score to voice to iMessage) works end to end by midnight before anyone polishes anything.

## How it works

```
Front camera ──> Presage SDK (on device) ──┐
Phone sensors (GPS, IMU) ──────────────────┼──> Feature vector ──> Risk score ──> Decision tree
Pre-trip self report ──────────────────────┘          │                              │
                                                      v              ┌───────────────┼───────────────┐
                                                 Tiger Data          v               v               v
                                               (trip windows)  ElevenLabs voice  Photon agent   Report card
                                                                  (driver)      (group chat)
```

Stack:
- **Android app (Kotlin, native).** Presage, risk score, decision tree, GPS, audio playback, speech recognition. Native Android because Presage ships native SDKs and Android installs over USB with no Apple signing.
- **Backend (Node / TypeScript).** Photon's SDK is TypeScript. Holds trip state, the message classifier, the queue of messages for the driver, ElevenLabs calls and the Tiger Data connection. The phone talks to it over a WebSocket.
- **ElevenLabs key stays on the backend**, never on the phone.

## 1. Driver sensing through Presage (MLH: Presage)

The front camera faces the driver. Presage processes video on the device and returns, about once per second:

- Blinks and iris / eye tracking
- Face points (head pose, nodding)
- Facial expression and talking detection
- Heart rate, heart rate variability, breathing rate
- Confidence and stability scores

Eyes are the primary drowsiness signal. Vitals change slowly and get noisy in a moving car, so they support the eye signals rather than lead.

How we turn signals into driver states:

**Drowsy**
- Share of time eyes are closed over a rolling 60 seconds rises
- Long, slow blinks; yawning; head nodding
- Breathing slows and heart rate trends down from the trip baseline

**Reckless / agitated**
- Heart rate spikes above baseline
- Stress or anger expressions
- Confirmed by phone sensors: hard braking, sharp turns, speeding

**Distracted**
- Gaze off the road for more than 2 seconds
- Engagement drop without the drowsy vitals pattern

Implementation notes:
- Record a 60 second baseline at the start of each trip. Score everything as a deviation from that baseline. People differ.
- Smooth every signal with a 10 second rolling average so one blink does not trigger an alert.
- Drop frames where Presage's confidence is low (bad light, head turned). Mark signals missing and lean on phone sensors.

Pitch line: most drowsiness detectors only track eyes. We track eyes and vitals and expression, which is the point of Presage.

## 2. Pre-trip check (stretch)

One screen before the trip. Everything stays on the phone and is opt in.
- "How rested do you feel?" 1 to 5, and hours slept last night
- Drowsy medication: yes / no
- Kids in the car: toggle
- Years of driving experience

## 3. Risk score

Each 10 second window produces a feature vector **x**, every feature normalized to 0..1:

```
x = [ eye_closure, long_blinks, yawns, head_nod, breathing_dev, heart_rate_dev,
      emotion_stress, hard_brake_count, swerve_count, speed_over_limit,
      sleep_deficit, hours_driving, night_time ]
```

Two weight vectors over the same **x** give two sub-scores, drowsy and reckless, so the tree knows which one fired.

**Base risk**

```
r = w · x
```

**Multiplier: speed and context raise the stakes of existing risk, they do not create it**

```
m = (1 + c · k) * (1 + b * v)
    c = context vector: kids_in_car, low_experience, medication
    v = current speed / 70 mph, capped at 1.5
R = clamp(100 * r * m, 0, 100)
```

Yawning three times in four minutes at 70 mph scores much higher than the same yawns at 20 mph.

**Weights**
- Tonight: hand-set weights so the demo works.
- Live adaptation (the "behavioral reinforcement" from the whiteboard, kept honest): when the driver says "I'm fine," nudge **w** with a small gradient step toward lower risk for that window. Show the weights shifting on the debug screen.
- Later: fit on labeled windows with ridge regression, w = (XᵀX + λI)⁻¹Xᵀy. We do not have labeled data tonight, so this is roadmap, not demo.

## 4. Decision tree

```
R < 40
  └─ Do nothing. Log the window.

40 ≤ R < 70
  ├─ drowsy dominant   → voice: calm check-in, offer a rest stop
  └─ reckless dominant → voice: calm reminder to slow down

70 ≤ R < 85
  ├─ drowsy dominant   → voice: firm warning, route to nearest rest stop
  ├─ reckless dominant → voice: firm warning
  └─ kids in car       → treat as next tier up

R ≥ 85  (or 70+ sustained for 2 minutes)
  ├─ voice: urgent, tell driver to pull over
  ├─ sharing on  → Photon agent alerts guardians and calls for the roast
  └─ sharing off → ask the driver by voice for permission to notify
```

Rules:
- An alert must hold for 15 seconds before firing, to prevent flicker
- 2 minute cooldown between voice alerts of the same tier
- Driver can always say "I'm fine" to dismiss. That feeds back into the weights.
- Alarm stage plays one loud bundled audio file. No music API.

## 5. Voice through ElevenLabs (both ElevenLabs tracks)

The driver never touches the screen. The app runs as a full-screen dashcam view, plugged in.

- **Tiered delivery.** Same voice, different settings: calm and warm at 40, firm at 70, urgent at 85.
- **Check-ins.** "You've been yawning a lot. Want me to find a rest stop?" "Yes" opens navigation. "I'm fine" logs the dismissal and backs off.
- **Reads family messages.** "Message from Mom: grab coffee at the next exit." Long messages are shortened to one line. Photos and links become "Mom sent a photo."
- **Listens for replies.** After reading a message, the phone listens for 5 seconds. "Tell her I'm stopping in ten" goes back to the group. Android's built-in speech recognizer handles this.
- **Keeps drowsy drivers talking.** At high drowsiness, family messages and roasts go through immediately, because a driver who answers back is proving they are awake.

## 6. The Photon agent (Agents in iMessage)

The agent lives in an iMessage group chat with the driver's chosen contacts, connected through Photon's Spectrum framework.

**Roles (allowlist on the backend)**
- **Guardians**: get safety alerts, location and trip details, can message the driver.
- **Friends**: can message and roast the driver, no location.

**Four flows**
1. **Contacts ask, agent answers.** "Where's Alex?" "How long has he been driving?" "Has he stopped?" Answered from live trip state, with detail matched to the asker's role.
2. **Contacts to driver.** "Tell Alex to grab coffee" is queued and spoken to the driver.
3. **Driver to contacts.** Voice replies are posted as "Alex says: stopping in 10 minutes."
4. **The roast.** At the alert tier the agent posts: "Alex has yawned 3 times in 4 minutes at 70 mph. Roast him awake." Replies are trimmed to one line and read aloud. When Alex answers, the agent reports he's alert.

**Understands social context**
- Every group message is classified: a question for the agent, a message for the driver, or the family chatting among themselves (agent stays quiet).
- Does not alarm people for a mid-tier event.
- Delivery to the driver is queued one at a time, never during a hard-braking event.

**Persists context (backed by Tiger Data)**
- Remembers past trips: "This is the third late-night drive this week."
- Remembers contact preferences: "Mom wants a message when he arrives."
- Sends an arrival message and a short trip summary.

**Sharing controls (driver's choice)**
- Always share state
- Share only on high risk
- Never share (agent asks by voice before notifying in an emergency)

**Fallback:** if Spectrum cannot join a group chat, each contact DMs the agent directly. All four flows still work. Test group chat support in hour one.

## 7. Trip log and report card (MLH: Tiger Data)

Every 10 second window (features, R, sub-scores, speed, location, events) is written to Tiger Data.

After each trip (stretch):
- Risk score over time (line chart)
- Letter grade and one sentence of advice
- Weekly trends: worst times of day to drive

## 8. Surroundings (stretch)

- GPS speed against the posted limit from OpenStreetMap (free Overpass API, hand-set fallback by road class), see [docs/gps.md](docs/gps.md)
- Weather from Open-Meteo (free, no key): rain, snow, low visibility
- Time of day / night driving

These collapse into one `surroundings_risk` feature. Rear camera object detection is cut for tonight.

## Build order

| When | What | Owner |
|---|---|---|
| 5:30 to 7:30 PM | Spectrum hello world in a group chat. Presage reading a face on the phone. ElevenLabs line playing on the phone. Tiger Data instance up. | [name] |
| 7:30 PM to midnight | Risk score with hand-set weights on screen. Decision tree wired to voice. Photon alert on high risk. | [name] |
| Midnight to 4 AM | Two-way Photon: classifier, relay queue, voice replies, roast flow. "I'm fine" weight nudge. Trip windows saved. | [name] |
| 4 to 8 AM | Sleep in shifts. Report card, GPS speed, weather if on track. | [name] |
| 8 to 10:30 AM | Feature freeze at 9. Rehearse demo, record video, write Devpost. | [name] |
| 10:30 to noon | Devpost tracks, Notability screenshots, buffer. Submit by 11:30. | [name] |

## Demo script (2 minutes)

1. Teammate sits in front of the phone on a tripod, alert. Screen shows live signals and a low score.
2. A judge holds a teammate's phone in the pre-made group chat and asks "where's Alex?" The agent answers.
3. Toggle "kids in car." Show the multiplier change.
4. Teammate fakes yawning and nodding. Score climbs live. ElevenLabs voice checks in; teammate says "I'm fine" and the weights shift on screen.
5. Teammate keeps nodding. Score passes 85. The agent posts the roast call. Friends roast; the phone reads them aloud.
6. Teammate laughs and answers out loud. The group sees "Alex says: pulling over at the next exit."
7. Show the trip timeline from Tiger Data.

## Devpost checklist

- Title and tagline that lean into the roast
- How each sponsor is used, named per track (Photon, ElevenLabs, Presage, Tiger Data, Notability)
- Notability: tag it in tools used, add 2+ screenshots of our notes
- Demo video, repo link, every track selected on the submission

## Safety note

This is a driver aid, not a medical device. It does not replace rest, and it does not control the vehicle. The driver never needs to touch the screen while driving.