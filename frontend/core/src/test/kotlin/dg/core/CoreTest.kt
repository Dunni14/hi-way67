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
        assertEquals(BackendFrame.Speak("1", "hi", 70, "QUJD", 8000, "checkin"),
            decodeBackendFrame("""{"type":"speak","id":"1","text":"hi","tier":70,"audio":"QUJD","listenAfterMs":8000,"context":"checkin"}"""))
        assertEquals(BackendFrame.Unknown("speak"), decodeBackendFrame("""{"type":"speak","x":1}"""))
        assertEquals("""{"type":"utterance","text":"im fine","context":"checkin"}""", encodeFrame(PhoneFrame.Utterance("im fine", "checkin")))
        assertEquals("""{"type":"speak_done","id":"1"}""", encodeFrame(PhoneFrame.SpeakDone("1")))
        assertEquals(BackendFrame.Dismissed, decodeBackendFrame("""{"type":"dismissed"}"""))
        assertEquals(BackendFrame.Navigate("rest stop"), decodeBackendFrame("""{"type":"navigate","query":"rest stop"}"""))
    }

    @Test fun reconnectBackoff() {
        val p = ReconnectPolicy()
        assertEquals(listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000), List(7) { p.nextDelayMs() })
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
