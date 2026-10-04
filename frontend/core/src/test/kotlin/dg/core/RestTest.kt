package dg.core

import kotlin.test.*

class RestTest {
    @Test fun windowBodyUsesBackendFieldNames() {
        val json = RestCodec.encode(SignalWindowBody(ts = "2026-10-04T10:00:10Z", heartRate = 70.0, longestEyeClosureS = 1.5, speedMph = 60.0))
        assertTrue("\"heart_rate\":70.0" in json, json)
        assertTrue("\"longest_eye_closure_s\":1.5" in json, json)
        assertFalse("phone_in_hand" in json, "null signals are omitted: $json")
    }

    @Test fun tripStartBody() {
        val json = RestCodec.encode(TripStartBody("d1", kidsInCar = true, sharingMode = SharingMode.HIGH_ONLY))
        assertTrue("\"driver_id\":\"d1\"" in json && "\"kids_in_car\":true" in json && "\"sharing_mode\":\"high_only\"" in json, json)
    }

    @Test fun evaluationParses() {
        val ev = RestCodec.evaluation("""{"score":72.5,"tier":2,"dominant":"drowsy","actions":["voice_warning","notify_contacts"],
            "levels":{"drowsy":0.8},"override":"microsleep","degraded":false,"extra":1}""")
        assertEquals(2, ev.tier)
        assertTrue(ev.notifiedContacts && !ev.wantsAlarm)
        assertEquals("microsleep", ev.override)
    }

    @Test fun reportAndHistoryParse() {
        val r = RestCodec.report("""{"trip_id":"t","driver_id":"d","started_at":"a","ended_at":null,"series":[{"ts":"x","score":10,"tier":0}],
            "max_score":10,"time_in_tier_s":{"0":120,"1":0,"2":0,"3":0},"grade":"A","events":[{"ts":"x","tier":1,"actions":["voice_nudge"],"override":null}]}""")
        assertEquals("A", r.grade)
        assertEquals(2, r.durationMin)
        val t = RestCodec.trips("""[{"trip_id":"t","started_at":"a","ended_at":null,"max_score":50,"grade":"C"}]""")
        assertEquals("C", t.single().grade)
    }

    @Test fun engineEmitsSignals() {
        val e = TripEngine(calibrationMs = 0)
        e.start(0)
        e.onMotion(70.0, null, null)
        e.onPresage(PresageFrame(1_000, eyeClosed = 0.9, heartRate = 72.0, yawn = true))
        e.onPresage(PresageFrame(2_000, eyeClosed = 0.9, heartRate = 74.0))
        e.onPresage(PresageFrame(3_000, eyeClosed = 0.0, heartRate = 74.0))
        val s = e.closeWindow(10_000, false, 12.0).signals
        assertEquals(true, s.faceVisible)
        assertEquals(2.0, s.longestEyeClosureS)
        assertEquals(1.0, s.yawns)
        assertEquals(70.0, s.speedMph)
        assertEquals(65.0, s.speedLimitMph)
        assertNull(s.phoneInHand)
        assertEquals("1970-01-01T00:00:10Z", s.ts)
    }
}
