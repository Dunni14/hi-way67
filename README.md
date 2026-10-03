# auto-ai
An AI driving partner
Track implementartion:
  # Driver Guardian (working title)

A phone on the dash that watches the driver, scores drowsiness and recklessness in real time, talks to the driver, and keeps their family in the loop over iMessage.

Built for MHacks 26.

## Tracks we are targeting

| Track | What they want | What we give them |
|---|---|---|
| MLH: Presage | Human Sensing Layer SDK used to read real-time physical and emotional state | Front camera vitals and emotion drive the whole risk score |
| Best Project Built with ElevenLabs | Best use of ElevenLabs | Hands-free voice agent that warns and talks with the driver |
| MLH: ElevenLabs | Natural, emotionally expressive voice for an interactive companion | Voice tone escalates with risk level |
| Agents in iMessage using Photon | Agent in iMessage via Spectrum that understands social context and persists context | Family group chat agent that reports driver state and answers questions |

Photon qualification rule: the agent must be connected to iMessage through Photon's Spectrum framework. Do this first, not last.

## How it works

```
Front camera ──> Presage SDK ──┐
Phone sensors (IMU, GPS) ──────┤
Rear camera (surroundings) ────┼──> Feature vector ──> Risk score ──> Decision tree
Health data + self report ─────┘                                        │
                                             ┌──────────────────────────┼───────────────┐
                                             v                          v               v
                                     ElevenLabs voice          Photon iMessage     Trip report card
```

## 1. Driver recognition through Presage (MLH: Presage)

The phone's front camera faces the driver. The Presage SDK runs on the video stream and returns, about once per second:

- Heart rate
- Breathing rate
- Engagement / focus level
- Facial expression and emotion
- Head and body movement

How we turn those into driver states:

**Drowsy**
- Breathing rate drops and becomes more regular
- Heart rate trends down from the trip baseline
- Engagement falls
- Long eye closures, yawning, head nodding

**Reckless / agitated**
- Heart rate spikes above baseline
- Anger or stress expressions
- Fast head movement, looking away from the road
- Confirmed by phone sensors: hard braking, sharp turns, speeding (accelerometer, gyroscope, GPS)

**Distracted**
- Gaze off the road for more than 2 seconds
- Engagement drop without the drowsy vitals pattern

Implementation notes:
- Record a 60 second baseline at the start of each trip. Score everything as a deviation from that baseline, not as absolute values. People differ.
- Smooth every signal with a 10 second rolling average so one blink does not trigger an alert.
- If Presage loses the face (bad light, head turned), mark signals as missing and lean on phone sensors.

Why this wins the track: most drowsiness detectors only track eyes. We use vitals and emotion, which is the point of Presage.

## 2. Health data upload and self reporting (Settings)

A settings screen where the driver adds context that changes how risky a given state is.

**Health data upload**
- Import sleep duration and resting heart rate from Apple Health / Google Health Connect, or upload a file export
- Last night's sleep feeds directly into the drowsiness prior
- Resting heart rate sharpens the Presage baseline

**Self report**
- Years of driving experience
- Usual sleep schedule
- Medications that cause drowsiness (yes/no only)
- Passengers: kids in the car (toggle per trip)
- Quick pre-trip check: "How rested do you feel?" 1 to 5

**Privacy**
- All health data stays on the device
- Driver chooses what, if anything, is shared with contacts
- Everything is opt in

Landing page: collects sign-ups and the same self-report questions from early users. This is our data source for fitting the risk weights.

## 3. Risk analysis with linear algebra

Each 10 second window produces a feature vector **x**:

```
x = [ breathing_dev, heart_rate_dev, engagement, eye_closure, emotion_stress,
      hard_brake_count, swerve_count, speed_over_limit,
      surroundings_risk,
      sleep_deficit, hours_driving, night_time ]
```

All features are normalized to 0..1.

**Base risk**

```
r = w · x          (weight vector w, dot product)
```

**Context multiplier**

Context does not add risk by itself. It raises the stakes of existing risk.

```
m = 1 + c · k      (c = context vector: kids_in_car, low_experience, medication)
R = clamp(100 · r · m, 0, 100)
```

**Fitting the weights**

- Start with hand-set weights so the demo works
- Fit with least squares on labeled windows: **w** = (XᵀX)⁻¹Xᵀy, where X is the matrix of feature windows and y is the labeled risk (from self reports and landing page data)
- Per-driver adaptation: when the driver dismisses an alert as wrong or confirms it, nudge **w** with a small gradient step. This is the "behavioral reinforcement" piece from the whiteboard, kept simple.

We keep two sub-scores, drowsy and reckless, by using two weight vectors over the same **x**. The tree needs to know which one fired.

## 4. Decision making tree

```
R < 40
  └─ Do nothing. Log.

40 ≤ R < 70
  ├─ drowsy dominant   → voice: calm check-in, offer music or a rest stop
  └─ reckless dominant → voice: calm reminder to slow down

70 ≤ R < 85
  ├─ drowsy dominant   → voice: firm warning, route to nearest rest stop
  ├─ reckless dominant → voice: firm warning
  └─ kids in car       → treat as next tier up

R ≥ 85  (or 70+ sustained for 2 minutes)
  ├─ voice: urgent, tell driver to pull over
  ├─ sharing = on      → Photon agent messages contacts
  └─ sharing = off     → ask driver by voice for permission to notify
```

Rules:
- An alert must hold for 15 seconds before firing, to prevent flicker
- 2 minute cooldown between voice alerts of the same tier
- Driver can always say "I'm fine" to dismiss. That feeds back into the weights.

## 5. Surrounding awareness

Risk depends on what is around the car, not only on the driver.

- **Rear camera** (phone mounted so it sees the road): detect lead vehicle distance, lane drift, pedestrians. Use an on-device object detector (YOLO-class model).
- **GPS and maps**: road type, speed limit, school zones, time of day
- **Weather API**: rain, snow, low visibility

These collapse into one `surroundings_risk` feature in **x**. A sleepy driver on an empty highway at noon scores lower than the same driver in rain near a school.

Hackathon scope: ship GPS, speed limit, time of day, and weather first. Rear camera detection is the stretch goal. One phone cannot easily run both cameras, so the demo can use a second phone or a recorded clip.

## 6. Voice through ElevenLabs (both ElevenLabs tracks)

The driver never touches the screen.

- Every decision tree branch triggers a spoken line through ElevenLabs
- **Emotionally expressive**: voice settings change by tier. Calm and warm at 40, firm at 70, urgent at 85. Same voice, different delivery.
- **Interactive**: built as an ElevenLabs conversational agent. It asks, the driver answers out loud.
  - "You've been yawning a lot. Want me to find a rest stop?"
  - "Yes" → opens navigation to the nearest one
  - "I'm fine" → logs the dismissal, backs off
- **Personal voice**: a family member can record a voice (with consent) so warnings come from someone the driver listens to
- **Keeps drowsy drivers talking**: at mid risk the agent can hold a short conversation to keep the driver alert until the next stop

## 7. Communication through Photon (Agents in iMessage)

The agent lives in an iMessage group chat with the driver's chosen contacts. Connected through Photon's Spectrum framework (required to qualify).

What the track asks for and how we cover it:

**Naturally participates in conversations**
- Sends alerts in plain language: "Alex has been showing signs of drowsiness for 5 minutes on I-94. He's 20 minutes from home."
- Contacts can ask anything: "How's he doing now?" "Where is he?" "Has he stopped?"
- Contacts can act: "Tell him to pull over" is relayed to the driver through the ElevenLabs voice

**Understands social context**
- Different tone and detail per contact. A parent gets full detail. A friend gets less.
- Stays quiet in the group chat unless there is something worth saying or someone asks
- Does not alarm people for a mid-tier event

**Persists context across interactions**
- Remembers past trips: "This is the third late-night drive this week."
- Remembers contact preferences: "Mom wants a message when he arrives."
- Sends an arrival message and a short trip summary

**Sharing controls (driver's choice)**
- Always share state
- Share only on high risk
- Never share (agent asks by voice before notifying in an emergency)

## 8. Trip report card and analytics

After each trip:
- Risk score over time (line chart)
- Events on a map: where drowsiness or hard braking happened
- Letter grade and one sentence of advice
- Weekly trends: best and worst times of day to drive

## Build order

1. Spectrum + iMessage hello world (qualifies us for Photon)
2. Presage SDK returning live vitals on the phone
3. Risk score with hand-set weights, shown on screen
4. Decision tree wired to ElevenLabs voice
5. Photon alert on high risk, then two-way replies
6. Settings: self report and health data
7. Report card
8. Surroundings: GPS and weather, then rear camera if time allows

## Demo script (2 minutes)

1. Teammate sits in front of the phone, alert. Score stays low.
2. Toggle "kids in car" in settings. Show the multiplier change.
3. Teammate fakes drowsiness. Score climbs live.
4. ElevenLabs voice checks in. Teammate answers out loud.
5. Score passes 85. A judge's phone gets the iMessage.
6. Judge replies "is he ok?" and the agent answers.
7. Show the report card.

## Safety note

This is a driver aid, not a medical device. It does not replace rest, and it does not control the vehicle.
