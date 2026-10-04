package dg.core

import java.io.File
import kotlin.test.*

class CoreTest {
    private fun sample(i: Int, score: Double, tier: Int = 0, alerted: Boolean = false, dominant: Dominant = Dominant.DROWSY, ev: List<String> = emptyList()) =
        TripSample(ts = i * 10_000L, score = score, tier = tier, dominant = dominant, alerted = alerted, events = ev)

    @Test fun reportCardEmpty() = assertNull(ReportCard.build(emptyList()))

    @Test fun tripRecapSpeedsAndAlertness() {
        val speed = SpeedTracker()
        assertNull(speed.avg); assertNull(speed.top)
        listOf(30.0, 60.0, 45.0, -1.0, Double.NaN).forEach(speed::add) // bad readings are ignored
        assertEquals(45.0, speed.avg); assertEquals(60.0, speed.top)

        val card = ReportCard.build((0 until 6).map { sample(it, 20.0) })
        val scored = TripRecap.of(durationMs = 61_000, speed = speed, card = card)
        assertEquals(2, scored.durationMin)
        assertEquals(80, scored.alertness); assertEquals("GOOD", scored.alertnessLabel)
        assertEquals("GREAT", TripRecap(1, null, null, TripRecap.alertnessOf(10.0)).alertnessLabel)
        assertEquals("LOW", TripRecap(1, null, null, TripRecap.alertnessOf(55.0)).alertnessLabel)

        // No backend verdicts: speeds still show, alertness is missing rather than made up.
        val unscored = TripRecap.of(durationMs = 30_000, speed = speed, card = null)
        assertEquals(45.0, unscored.avgSpeedMph); assertNull(unscored.alertness); assertNull(unscored.alertnessLabel)
    }

    @Test fun tripHistoryKeepsNewestFirstAndSurvivesBadData() {
        fun trip(n: Long) = TripSummary(endedAtMs = n, durationMin = 5, grade = "B", avgRisk = 20.0, peakRisk = 45.5, alerts = 1, demo = n % 2 == 0L)
        var h = emptyList<TripSummary>()
        for (n in 1L..(TripHistory.MAX_TRIPS + 5)) h = TripHistory.add(h, trip(n))
        assertEquals(TripHistory.MAX_TRIPS, h.size)
        assertEquals(TripHistory.MAX_TRIPS + 5L, h.first().endedAtMs) // newest first
        assertEquals(6L, h.last().endedAtMs) // oldest five dropped
        assertEquals(h, TripHistory.decode(TripHistory.encode(h)))
        assertEquals(emptyList(), TripHistory.decode(null))
        assertEquals(emptyList(), TripHistory.decode("not json"))

        // Speeds are saved with the trip; history written before they existed still loads, without them.
        val speed = SpeedTracker().apply { add(40.0); add(70.0) }
        val saved = TripSummary.of(ReportCard.build((0 until 6).map { sample(it, 20.0) })!!, endedAtMs = 99, demo = false, speed = speed)
        assertEquals(55.0, saved.avgSpeedMph); assertEquals(70.0, saved.topSpeedMph)
        assertEquals(listOf(saved), TripHistory.decode(TripHistory.encode(listOf(saved))))
        val old = TripHistory.decode("""[{"endedAtMs":1,"durationMin":5,"grade":"B","avgRisk":20.0,"peakRisk":45.5,"alerts":1,"demo":true}]""").single()
        assertEquals("B", old.grade); assertNull(old.avgSpeedMph); assertNull(old.topSpeedMph)
    }

    @Test fun reportCardCalmTripGetsA() {
        val c = ReportCard.build(List(31) { sample(it, 5.0) })!!
        assertEquals("A", c.grade)
        assertEquals(5, c.durationMin)
        assertEquals(31, c.series.size)
        assertTrue(c.alertsByTier.isEmpty())
    }

    @Test fun reportCardRiskyTripIsPenalized() {
        val ws = List(30) { i ->
            when {
                i < 12 -> sample(i, 20.0)
                i == 12 -> sample(i, 60.0, tier = 2, alerted = true, ev = listOf(DriverEvent.YAWN))
                i == 20 -> sample(i, 90.0, tier = 3, alerted = true)
                else -> sample(i, 90.0, tier = 3)
            }
        }
        val c = ReportCard.build(ws)!!
        assertTrue(c.grade in listOf("D", "F"), c.grade)
        assertEquals(90.0, c.peakRisk)
        assertEquals(mapOf(2 to 1, 3 to 1), c.alertsByTier)
        assertEquals(mapOf(DriverEvent.YAWN to 1), c.eventCounts)
        assertTrue(c.advice.contains("break"))
    }

    @Test fun reportCardRecklessAdvice() {
        val ws = List(10) { sample(it, 80.0, tier = 2, dominant = Dominant.RECKLESS, ev = listOf(DriverEvent.HARD_BRAKE)) }
        assertTrue(ReportCard.build(ws)!!.advice.contains("braking"))
    }

    @Test fun framesMatchProtocol() {
        assertEquals("""{"type":"hello","driverName":"A","sharingMode":"high_only","kidsInCar":false}""",
            encodeFrame(PhoneFrame.Hello("A")))
        assertEquals("""{"type":"trip_start"}""", encodeFrame(PhoneFrame.TripStart))
        val w = PhoneFrame.RiskWindow(ts = 1, speed = 65.0, events = listOf(DriverEvent.YAWN),
            signals = WindowSignals(faceVisible = true, eyeClosureFrac = 0.4, longestEyeClosureS = 2.2, yawns = 1, speedMph = 65.0))
        assertEquals(
            """{"type":"risk_window","ts":1,"speed":65.0,"events":["yawn"],"signals":{"face_visible":true,"eye_closure_frac":0.4,"longest_eye_closure_s":2.2,"yawns":1,"speed_mph":65.0}}""",
            encodeFrame(w),
        )
        assertEquals(BackendFrame.Dismissed(), decodeBackendFrame("""{"type":"dismissed"}"""))
        assertEquals(BackendFrame.Dismissed("drowsy", 0.95), decodeBackendFrame("""{"type":"dismissed","factor":"drowsy","multiplier":0.95}"""))
        assertEquals(BackendFrame.Navigate("rest stop"), decodeBackendFrame("""{"type":"navigate","query":"rest stop"}"""))
    }

    @Test fun reportDecodes() {
        val r = decodeBackendFrame(
            """{"type":"report","score":33.1,"grade":"F","summary":"Alex's drive was risky.","avg_speed_mph":58,"top_speed_mph":61.5,""" +
                """"attention_score":97,"duration_s":1020,"distance_mi":16.2,"image":"iVBORw0KGgo="}""",
        ) as BackendFrame.Report
        assertEquals(33.1, r.score, 1e-9)
        assertEquals("F", r.grade)
        assertEquals("Alex's drive was risky.", r.summary)
        assertEquals(58.0, r.avgSpeedMph, 1e-9)
        assertEquals(61.5, r.topSpeedMph, 1e-9)
        assertEquals(97.0, r.attentionScore, 1e-9)
        assertEquals(1020, r.durationS)
        assertEquals(16.2, r.distanceMi, 1e-9)
        assertEquals("iVBORw0KGgo=", r.image)
        // A frame with only the type still decodes (every field defaults), so an older backend never crashes the app.
        assertEquals(BackendFrame.Report(0.0, "", "", 0.0, 0.0, 0.0, 0, 0.0, ""), decodeBackendFrame("""{"type":"report"}"""))
    }

    @Test fun evaluationDecodes() {
        val e = decodeBackendFrame(
            """{"type":"evaluation","ts":5,"score":22.5,"tier":2,"dominant":"drowsy","levels":{"drowsy":0.67,"speeding":0},""" +
                """"override":"drowsy_sustained_3","degraded":false,"actions":["voice_warning"],"calibrating":false}""",
        )
        assertEquals(
            BackendFrame.Evaluation(5, 22.5, 2, Dominant.DROWSY, mapOf("drowsy" to 0.67, "speeding" to 0.0), "drowsy_sustained_3", false, listOf("voice_warning"), false),
            e,
        )
        val quiet = decodeBackendFrame("""{"type":"evaluation","ts":1,"score":0,"tier":0,"dominant":"drowsy","levels":{},"override":null,"degraded":false,"actions":["none"],"calibrating":true}""")
        assertEquals(null, (quiet as BackendFrame.Evaluation).override)
        assertTrue(quiet.calibrating)
    }

    @Test fun voiceFramesMatchProtocol() {
        assertEquals(
            BackendFrame.Speak("1", "Hey there", 40, "AAAA", 5000, SpeakContext.CHECKIN),
            decodeBackendFrame("""{"type":"speak","id":"1","text":"Hey there","tier":40,"audio":"AAAA","listenAfterMs":5000,"context":"checkin","x":1}"""),
        )
        assertEquals(BackendFrame.Unknown("speak"), decodeBackendFrame("""{"type":"speak"}"""))
        assertEquals("""{"type":"speak_done","id":"1"}""", encodeFrame(PhoneFrame.SpeakDone("1")))
        assertEquals("""{"type":"utterance","text":"I'm fine","context":"checkin"}""",
            encodeFrame(PhoneFrame.Utterance("I'm fine", SpeakContext.CHECKIN)))
        assertEquals("""{"type":"utterance","text":"hi","context":"free"}""", encodeFrame(PhoneFrame.Utterance("hi")))
    }

    @Test fun aggregatorSummarizesAWindow() {
        val a = WindowAggregator()
        a.onMotion(70.0, 42.0, -83.0)
        for (s in 1..10) a.onPresage(PresageFrame(tsMs = s * 1000L, eyeClosed = if (s <= 5) 0.0 else 1.0, heartRate = 70.0, breathing = 14.0,
            yawn = s == 3, closedRunMs = if (s == 8) 2_500 else 100))
        a.onPresage(PresageFrame(tsMs = 11_000, confidence = 0.1, eyeClosed = 1.0, yawn = true)) // no face: ignored
        a.onImuEvent(DriverEvent.HARD_BRAKE)
        val w = a.close(12_000)
        val s = w.signals
        assertEquals(true, s.faceVisible)
        assertEquals(0.5, s.eyeClosureFrac!!, 1e-9)
        assertEquals(2.5, s.longestEyeClosureS!!, 1e-9)
        assertEquals(1, s.yawns)
        assertEquals(70.0, s.heartRate)
        assertEquals(1, s.hardBrakes)
        assertEquals(70.0, s.speedMph)
        assertEquals(SPEED_LIMIT_MPH, s.speedLimitMph)
        assertEquals(listOf(DriverEvent.YAWN, DriverEvent.HARD_BRAKE), w.events)
        assertEquals(42.0, w.lat)
        // Next window starts empty; a window with frames but no usable face says so.
        a.onPresage(PresageFrame(tsMs = 13_000, confidence = 0.0))
        val hidden = a.close(22_000).signals
        assertEquals(false, hidden.faceVisible)
        assertNull(hidden.eyeClosureFrac)
        assertNull(hidden.longestEyeClosureS)
    }

    /** Synthetic 478-point mesh: eyes with the given lid gap (width 10), mouth with the given lip gap (width 10). */
    private fun mesh(eyeGap: Double, lipGap: Double): List<Pt> {
        val p = MutableList(478) { Pt(0.0, 0.0) }
        for ((dx, eye) in listOf(0.0 to intArrayOf(33, 160, 158, 133, 153, 144), 20.0 to intArrayOf(362, 385, 387, 263, 373, 380))) {
            p[eye[0]] = Pt(dx, 0.0); p[eye[3]] = Pt(dx + 10, 0.0)
            p[eye[1]] = Pt(dx + 3, -eyeGap / 2); p[eye[2]] = Pt(dx + 7, -eyeGap / 2)
            p[eye[5]] = Pt(dx + 3, eyeGap / 2); p[eye[4]] = Pt(dx + 7, eyeGap / 2)
        }
        p[78] = Pt(5.0, 20.0); p[308] = Pt(15.0, 20.0)
        p[13] = Pt(10.0, 20.0 - lipGap / 2); p[14] = Pt(10.0, 20.0 + lipGap / 2)
        return p
    }

    @Test fun faceGeometryRatios() {
        val open = mesh(eyeGap = 3.0, lipGap = 0.5)
        assertEquals(0.3, FaceGeometry.eyeOpenness(open)!!, 1e-9)
        assertEquals(0.0, FaceGeometry.eyeClosure(FaceGeometry.eyeOpenness(open)!!))
        assertEquals(1.0, FaceGeometry.eyeClosure(FaceGeometry.eyeOpenness(mesh(1.0, 0.5))!!))
        assertEquals(0.05, FaceGeometry.mouthOpenness(open)!!, 1e-9)
        assertEquals(0.7, FaceGeometry.mouthOpenness(mesh(3.0, 7.0))!!, 1e-9)
        assertNull(FaceGeometry.eyeOpenness(open.take(100)))
    }

    /** A 30 s closure reads as one long run in every second it spans, not as 1 s pieces. */
    @Test fun faceSamplerTracksLongEyeClosure() {
        val s = FaceSampler()
        val open = mesh(eyeGap = 3.0, lipGap = 0.5)
        val shut = mesh(eyeGap = 0.5, lipGap = 0.5)
        val longest = mutableListOf<Long>()
        var t = 0L
        for (sec in 0 until 40) {
            repeat(30) { t += 33; s.add(t * 1000, if (sec in 5 until 35) shut else open) } // µs timestamps
            longest += s.drain().longestClosedMs
        }
        assertTrue(longest.take(5).all { it == 0L })
        assertTrue(longest[6] in 1_900L..2_100L, "1 s into the closure: ${longest[6]}")
        assertTrue(longest[34] >= 29_000L, "end of a 30 s closure: ${longest[34]}")
        assertEquals(0L, longest[36])
    }

    @Test fun yawnNeedsSustainedOpenMouthAndRefractory() {
        val y = YawnDetector()
        assertFalse(y.update(0, 0.7))
        assertFalse(y.update(1_000, 0.7)) // only 1 s open
        assertTrue(y.update(1_500, 0.7)) // 1.5 s -> yawn
        assertFalse(y.update(3_500, 0.7)) // within refractory
        assertFalse(y.update(4_000, 0.2)) // closes
        assertFalse(y.update(6_000, 0.7))
        assertTrue(y.update(7_500, 0.7)) // second yawn, 6 s after the first
        assertFalse(y.update(8_000, null)) // missing face resets
    }

    /** Batches of landmark samples, re-delivered and in any timestamp unit, still yield one yawn. */
    @Test fun faceSamplerFindsYawnInBatches() {
        for (unit in listOf(1L, 1_000L, 1_000_000L)) { // ms, µs, ns
            val s = FaceSampler()
            val closed = mesh(eyeGap = 3.0, lipGap = 0.5)
            val yawning = mesh(eyeGap = 2.0, lipGap = 8.0)
            val frames = (0 until 150).map { i -> (1_000_000L + i * 33L) * unit to if (i in 30..120) yawning else closed } // 5 s at 30 fps
            val summaries = mutableListOf<FaceSummary>()
            frames.chunked(30).forEach { batch ->
                batch.forEach { (ts, p) -> s.add(ts, p) }
                batch.forEach { (ts, p) -> assertFalse(s.add(ts, p)) } // re-delivered batch is ignored
                summaries += s.drain()
            }
            assertEquals(unit, s.unitsPerMs, "unit")
            assertEquals(1, s.totalYawns, "unit $unit")
            assertEquals(1, summaries.count { it.yawned })
            assertTrue(summaries.all { it.samples == 30 })
            assertEquals(0.8, summaries[2].mouthOpenMax!!, 1e-9)
            assertTrue(summaries[0].eyeClosed!! < 0.1)
        }
    }

    /** At ~30 fps a real yawn has jittery frames; short dips must not split it, speech must not count. */
    @Test fun yawnAtFrameRate() {
        val y = YawnDetector()
        var yawns = 0
        // 2 s of speech: mouth flaps open for 200 ms at a time.
        for (t in 0L until 2_000L step 33) if (y.update(t, if ((t / 200) % 2 == 0L) 0.7 else 0.2)) yawns++
        assertEquals(0, yawns, "speech counted as a yawn")
        // 3 s yawn with a dropped/jittery frame every 300 ms.
        for (t in 5_000L until 8_000L step 33) if (y.update(t, if (t % 300 < 33) 0.4 else 0.8)) yawns++
        assertEquals(1, yawns)
    }

    /** Shapes captured from the backend (fake DB): GET /drivers/alex/trips and GET /trips/{id}/card. */
    @Test fun historyDecodesBackendJson() {
        val trips = History.decodeTrips(
            """[{"trip_id":"fake-alex-4","started_at":"2026-10-03T09:10:31.572Z","ended_at":"2026-10-03T09:30:41.572Z","max_score":4.4,"grade":"A","card_score":98.6,"card_grade":"A"},""" +
                """{"trip_id":"t2","started_at":"2026-10-04T03:01:20Z","ended_at":null,"max_score":100,"grade":"D","card_score":null,"card_grade":null}]""",
        )
        assertEquals(2, trips.size)
        assertEquals("A", trips[0].displayGrade)
        assertEquals(98.6, trips[0].cardScore)
        assertEquals("D", trips[1].displayGrade) // no card yet: max-tier grade
        assertNull(trips[1].endedAt)

        val card = History.decodeCard(
            """{"gps":null,"grade":"D","score":60.5,"counts":{"swerves":1,"hard_brakes":2,"phone_windows":0,"speeding_windows":0},""" +
                """"series":[{"ts":"2026-10-03T09:10:30.000Z","tier":0,"score":0},{"ts":"2026-10-03T09:11:00.000Z","tier":3,"score":72.5}],""" +
                """"metrics":{"yawns":3,"phone_s":0,"feedback":{"confirmed":0,"false_alarm":1},"max_risk":100,"max_tier":3,"overrides":{"microsleep":1,"drowsy_sustained_3":2},""" +
                """"degraded_s":0,"duration_s":1200,"night_trip":true,"distance_mi":19.292,"over_limit_s":0,"tier_seconds":[900,0,200,100],"avg_speed_mph":57.9,""" +
                """"interventions":{"voice_nudge":0,"voice_urgent":1,"voice_warning":2,"notify_contacts":1,"ask_permission_to_notify":0},"max_speed_mph":60.9,""" +
                """"gaze_off_road_s":25.5,"longest_eye_closure_s":2.2,"hr_above_baseline_mean":null},"profile":null,"features":[1,2],"provisional":false,"formula_version":1}""",
        )
        assertEquals("D", card.grade)
        assertEquals(2, card.series.size)
        assertEquals(3, card.metrics.maxTier)
        assertEquals(listOf(900.0, 0.0, 200.0, 100.0), card.metrics.tierSeconds)
        assertEquals(listOf("Urgent warnings" to 1, "Warnings" to 2, "Contacts alerted" to 1), History.alertSummary(card))
        assertEquals(setOf("Eyes closed too long" to 1, "Drowsy for 30 s" to 2), History.overrideSummary(card).toSet())
        assertEquals(2.0, card.counts.hardBrakes)

        assertEquals("Ray", History.driverNameFromHealth("""{"ok":true,"driverName":"Ray","tripActive":false}"""))
        assertNull(History.driverNameFromHealth("""{"ok":true}"""))
    }

    /** Shape captured from GET /drivers/Ray/stats on the live backend. */
    @Test fun statsDecodesBackendJson() {
        val s = History.decodeStats(
            """{"driver_id":"Ray","days":7,"safety_score":88.7,"trips":10,"safe_trips":8,"risk_events":2,""" +
                """"daily":[{"date":"2026-10-03","label":"Sat","score":null,"trips":0},{"date":"2026-10-04","label":"Sun","score":88.7,"trips":10}],""" +
                """"attention":{"value":"GOOD","calm_share":0.923},"eye_tracking":{"value":"NORMAL","microsleeps":0,"longest_closure_s":0.6},""" +
                """"avg_speed_mph":65,"distance_mi":16.8,"hard_brakes":0,"yawns":14,"night_share":0.5,""" +
                """"tips":[{"title":"Watch for tiredness","detail":"14 yawns this week."}]}""",
        )
        assertEquals(88.7, s.safetyScore)
        assertEquals(8, s.safeTrips)
        assertEquals(listOf(null, 88.7), s.daily.map { it.score })
        assertEquals("GOOD", s.attention.value)
        assertEquals(0.923, s.attention.calmShare)
        assertEquals("NORMAL", s.eyeTracking.value)
        assertEquals(65.0, s.avgSpeedMph)
        assertEquals(0.5, s.nightShare)
        assertEquals("Watch for tiredness", s.tips.single().title)
        // An empty week decodes too.
        val empty = History.decodeStats("""{"driver_id":"x","days":7,"safety_score":null,"trips":0,"safe_trips":0,"risk_events":0,"daily":[],"attention":{"value":null,"calm_share":null},"eye_tracking":{"value":null,"microsleeps":0,"longest_closure_s":0},"avg_speed_mph":null,"distance_mi":0,"hard_brakes":0,"yawns":0,"night_share":null,"tips":[]}""")
        assertNull(empty.safetyScore)
        assertNull(empty.attention.value)
    }

    @Test fun reconnectBackoff() {
        val p = ReconnectPolicy()
        assertEquals(listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000), List(7) { p.nextDelayMs() })
    }

    @Test fun demoClockRoundTrips() {
        assertEquals(15_000, DemoClock.realMs(180_000))
        assertEquals(180_000, DemoClock.scriptMs(15_000))
        for (ms in listOf(0L, 5_000, 15_000, 40_000, 120_000)) assertEquals(ms, DemoClock.realMs(DemoClock.scriptMs(ms)))
    }

    /**
     * The demo profile as TripController sends it: one window per 10 script seconds, stamped in real
     * time. Checks the shape the engine relies on, and writes build/demo-windows.json so the backend
     * can replay it through the real engine (`npx tsx src/dev/replayDemo.ts` in backend/).
     */
    @Test fun demoWindowsMatchTheEngineProfile() {
        val a = WindowAggregator()
        a.onMotion(DemoScript.DEMO_SPEED_MPH, 42.2808, -83.743)
        val t0 = 1_800_000_000_000L
        val windows = mutableListOf<PhoneFrame.RiskWindow>()
        var s = 0
        for (win in 1..30) {
            while (s < win * 10) { s++; a.onPresage(DemoScript.frame(t0 + s * 1000L, s.toDouble())) }
            windows += a.close(t0 + DemoClock.realMs(s * 1000L) + win) // real-time stamp, unique per window
        }
        val calm = windows.take(13)
        val drowsy = windows.drop(13)
        assertTrue(calm.all { it.signals.eyeClosureFrac!! < 0.1 && it.signals.yawns == 0 })
        assertTrue(drowsy.all { it.signals.eyeClosureFrac!! > 0.35 && it.signals.breathingRate == 10.5 && it.signals.yawns == 1 })
        assertEquals(26, windows.indexOfFirst { it.signals.longestEyeClosureS!! >= 1.5 } + 1, "microsleep window")
        assertTrue(windows.zipWithNext().all { (x, y) -> y.ts > x.ts })
        File("build").mkdirs()
        File("build/demo-windows.json").writeText(windows.joinToString(",\n", "[\n", "\n]") { encodeFrame(it) })
    }
}
