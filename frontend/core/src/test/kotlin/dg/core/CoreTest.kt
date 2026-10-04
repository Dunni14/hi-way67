package dg.core

import kotlin.test.*

class CoreTest {
    private fun x(vararg p: Pair<String, Double?>): Features =
        FEATURES.associateWith { 0.0 } + mapOf(*p)

    @Test fun speedRaisesScore() {
        val yawns = x("yawns" to 0.75, "eye_closure" to 0.2)
        val fast = RiskModel().score(yawns, 70.0, false).R
        val slow = RiskModel().score(yawns, 20.0, false).R
        assertTrue(fast > slow * 1.4, "fast=$fast slow=$slow")
    }

    @Test fun kidsRaiseMultiplier() {
        assertTrue(RiskModel.multiplier(60.0, true) > RiskModel.multiplier(60.0, false))
    }

    @Test fun clampedAndRenormalized() {
        val all = FEATURES.associateWith { 1.0 }
        assertEquals(100.0, RiskModel().score(all, 100.0, true).R)
        val half = x("yawns" to 0.5, "eye_closure" to null, "long_blinks" to null, "head_nod" to 0.5)
        val blind = RiskModel().score(half, 0.0, false)
        val sane = RiskModel().score(half + mapOf("eye_closure" to 0.0, "long_blinks" to 0.0), 0.0, false)
        assertTrue(blind.R > sane.R)
    }

    @Test fun gateRules() {
        val g = AlertGate()
        assertNull(g.update(0, 50.0, true)) // calibration
        assertNull(g.update(10_000, 50.0, false)) // band starts
        assertNull(g.update(20_000, 50.0, false)) // 10 s held
        assertEquals(40, g.update(25_000, 50.0, false)) // 15 s held
        assertNull(g.update(30_000, 50.0, false)) // cooldown
        assertNull(g.update(35_000, 10.0, false)) // dip resets
        assertNull(g.update(40_000, 75.0, false))
        assertEquals(70, g.update(55_000, 75.0, false)) // 40 cooldown does not block 70
        assertNull(g.update(60_000, 75.0, false))
        assertEquals(85, g.update(175_000, 75.0, false)) // 70 for 120 s -> 85
        assertNull(g.update(180_000, 75.0, false))
    }

    private fun win(i: Int, r: Double, d: Double = r, rk: Double = 0.0, ev: List<String> = emptyList()) =
        PhoneFrame.RiskWindow(ts = i * 10_000L, risk = r, drowsy = d, reckless = rk, events = ev)

    @Test fun reportCardEmpty() = assertNull(ReportCard.build(emptyList(), emptyList()))

    @Test fun reportCardCalmTripGetsA() {
        val c = ReportCard.build(List(30) { win(it, 5.0) }, emptyList())!!
        assertEquals("A", c.grade)
        assertEquals(5, c.durationMin)
        assertEquals(30, c.series.size)
        assertTrue(c.alertsByTier.isEmpty())
    }

    @Test fun reportCardRiskyTripIsPenalized() {
        val ws = List(30) { win(it, if (it < 12) 20.0 else 90.0, ev = if (it == 20) listOf(DriverEvent.YAWN) else emptyList()) }
        val c = ReportCard.build(ws, listOf(40, 70, 85, 85))!!
        assertTrue(c.grade in listOf("D", "F"), c.grade)
        assertEquals(90.0, c.peakRisk)
        assertEquals(mapOf(40 to 1, 70 to 1, 85 to 2), c.alertsByTier)
        assertEquals(mapOf(DriverEvent.YAWN to 1), c.eventCounts)
        assertTrue(c.advice.contains("break"))
    }

    @Test fun reportCardRecklessAdvice() {
        val ws = List(10) { win(it, 80.0, d = 10.0, rk = 80.0, ev = listOf(DriverEvent.HARD_BRAKE)) }
        assertTrue(ReportCard.build(ws, listOf(70))!!.advice.contains("braking"))
    }

    @Test fun nudgeNeverNegative() {
        val m = RiskModel()
        m.score(FEATURES.associateWith { 1.0 }, 0.0, false)
        repeat(100) { m.weights.nudge(m.latestDominant, m.latestX) }
        assertTrue(m.weights.of(m.latestDominant).values.all { it >= 0.0 })
    }

    @Test fun framesMatchProtocol() {
        assertEquals("""{"type":"hello","driverName":"A","sharingMode":"high_only","kidsInCar":false}""",
            encodeFrame(PhoneFrame.Hello("A")))
        assertEquals("""{"type":"alert","tier":70,"dominant":"reckless","R":72.0}""",
            encodeFrame(PhoneFrame.Alert(70, Dominant.RECKLESS, 72.0)))
        assertEquals("""{"type":"trip_start"}""", encodeFrame(PhoneFrame.TripStart))
        assertTrue(encodeFrame(PhoneFrame.RiskWindow(1, 2.0, 3.0, 4.0)).contains(""""R":2.0"""))
        assertEquals(BackendFrame.Dismissed, decodeBackendFrame("""{"type":"dismissed"}"""))
        assertEquals(BackendFrame.Navigate("rest stop"), decodeBackendFrame("""{"type":"navigate","query":"rest stop"}"""))
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

    @Test fun reconnectBackoff() {
        val p = ReconnectPolicy()
        assertEquals(listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000), List(7) { p.nextDelayMs() })
    }

    /** Demo mode as TripController runs it: DemoClock pacing, cooldown kept at 2 real minutes. */
    @Test fun demoPacingLeavesTimeToReply() {
        val clock = DemoClock
        val engine = TripEngine(gate = AlertGate(cooldownMs = (120_000L * clock.steadyRate).toLong()))
        val t0 = 1_000_000L
        engine.start(t0)
        engine.onMotion(DemoScript.DEMO_SPEED_MPH, 42.28, -83.74)
        val fired = mutableListOf<Pair<Int, Double>>() // tier to real seconds
        var s = 0
        var win = 0
        while (clock.realMs(s * 1000L) < 300_000) { // 5 real minutes of 10 s script windows
            win++
            while (s < win * 10) { s++; engine.onPresage(DemoScript.frame(t0 + s * 1000L, s.toDouble())) }
            engine.closeWindow(t0 + s * 1000L, false, 14.0).alertTier?.let { fired += it to clock.realMs(s * 1000L) / 1000.0 }
        }
        println("demo alerts (tier to real s): $fired")
        assertEquals(listOf(40, 70, 85), fired.take(3).map { it.first })
        assertTrue(fired[0].second <= 16.0, "first check-in at ${fired[0].second}s")
        assertTrue(fired[1].second - fired[0].second >= 20.0, "only ${fired[1].second - fired[0].second}s to answer the check-in")
        assertTrue(fired[2].second - fired[1].second >= 20.0, "only ${fired[2].second - fired[1].second}s between 70 and 85")
        assertTrue(fired[2].second <= 100.0, "85 at ${fired[2].second}s")
        // Repeats (alarm, group alert) stay at least 2 real minutes apart.
        fired.drop(3).forEach { assertTrue(it.second - fired[2].second >= 119.0, "repeat 85 at ${it.second}s") }
    }

    @Test fun demoClockRoundTrips() {
        assertEquals(15_000, DemoClock.realMs(180_000))
        assertEquals(180_000, DemoClock.scriptMs(15_000))
        for (ms in listOf(0L, 5_000, 15_000, 40_000, 120_000)) assertEquals(ms, DemoClock.realMs(DemoClock.scriptMs(ms)))
    }

    /** Scripted run must hit 40 / 70 / 85 in order with drowsy dominant. */
    @Test fun scriptedRunHitsAllTiers() {
        val engine = TripEngine()
        val t0 = 1_000_000L
        engine.start(t0)
        engine.onMotion(DemoScript.DEMO_SPEED_MPH, 42.28, -83.74)
        val fired = mutableListOf<Pair<Int, Dominant>>()
        var s = 0
        for (win in 1..80) {
            while (s < win * 10) { s++; engine.onPresage(DemoScript.frame(t0 + s * 1000L, s.toDouble())) }
            val out = engine.closeWindow(t0 + s * 1000L, false, 14.0)
            println("t=${s}s R=%.0f drowsy=%.0f reckless=%.0f m=%.2f calib=${out.calibrating} alert=${out.alertTier}".format(out.result.R, out.result.drowsy, out.result.reckless, out.result.m))
            out.alertTier?.let { fired += it to out.dominant }
        }
        assertEquals(listOf(40, 70, 85), fired.take(3).map { it.first })
        assertTrue(fired.drop(3).all { it.first == 85 })
        assertTrue(fired.all { it.second == Dominant.DROWSY })
    }
}
