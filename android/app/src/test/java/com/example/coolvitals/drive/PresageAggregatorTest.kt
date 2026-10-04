package com.example.coolvitals.drive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresageAggregatorTest {
    private var clock = 1_000_000L
    private val agg = PresageAggregator { clock }

    /** Face pipeline running with a valid face. */
    private fun live() {
        agg.onValidation(true)
        agg.onFrame()
    }

    @Test fun noFaceMeansFaceNotVisibleAndNoVitals() {
        agg.onPulse(70f, 0.9f)
        val s = agg.snapshot()
        assertEquals(false, s["face_visible"])
        assertFalse(s.containsKey("heart_rate")) // never send vitals read without a validated face
    }

    @Test fun validFaceSendsLatestConfidentVitals() {
        live()
        agg.onPulse(68f, 0.9f)
        agg.onPulse(72f, 0.8f)
        agg.onBreathing(15f, 0.7f)
        val s = agg.snapshot()
        assertEquals(true, s["face_visible"])
        assertEquals(72.0, s["heart_rate"] as Double, 0.0)
        assertEquals(15.0, s["breathing_rate"] as Double, 0.0)
    }

    @Test fun lowConfidenceVitalsAreDropped() {
        live()
        agg.onPulse(70f, 0.9f)
        agg.onPulse(150f, 0.2f) // noisy frame must not replace a good reading
        agg.onBreathing(40f, 0.1f)
        val s = agg.snapshot()
        assertEquals(70.0, s["heart_rate"] as Double, 0.0)
        assertFalse(s.containsKey("breathing_rate"))
    }

    @Test fun vitalsGoStaleButCarryOverBetweenWindows() {
        live()
        agg.onPulse(70f, 0.9f)
        clock += 10_000
        agg.onFrame()
        assertEquals(70.0, agg.snapshot()["heart_rate"] as Double, 0.0) // 10 s old: still evidence
        clock += 15_000
        agg.onFrame()
        assertFalse(agg.snapshot().containsKey("heart_rate")) // 25 s old: stale
    }

    @Test fun faceLostWhenMetricsStop() {
        live()
        assertEquals(true, agg.snapshot()["face_visible"])
        clock += FACE_STALE_MS + 1
        assertEquals(false, agg.snapshot()["face_visible"])
    }

    @Test fun validationFailingMeansNoFace() {
        live()
        agg.onValidation(false)
        assertEquals(false, agg.snapshot()["face_visible"])
    }

    @Test fun eyeClosureIsTheShareOfDetectedSamplesInTheWindow() {
        live()
        agg.onBlinks(listOf(BlinkSample(1, false), BlinkSample(2, true), BlinkSample(3, true), BlinkSample(4, false)))
        assertEquals(0.5, agg.snapshot()["eye_closure_frac"] as Double, 1e-9)
    }

    @Test fun blinkListSeenAgainIsNotCountedTwiceAndWindowsAreIndependent() {
        live()
        val all = listOf(BlinkSample(1, true), BlinkSample(2, false))
        agg.onBlinks(all)
        agg.onBlinks(all) // the SDK re-sends its cumulative list
        assertEquals(0.5, agg.snapshot()["eye_closure_frac"] as Double, 1e-9)
        agg.onBlinks(all + BlinkSample(3, false))
        assertEquals(0.0, agg.snapshot()["eye_closure_frac"] as Double, 1e-9) // only the new sample
        assertFalse(agg.snapshot().containsKey("eye_closure_frac")) // nothing new: no evidence, not zero
    }

    @Test fun microsleepInputIsOffUntilValidatedOnADevice() {
        assertFalse("longest_eye_closure_s drives the tier 3 override: keep it off until verified", SEND_LONGEST_CLOSURE)
        live()
        agg.onBlinks((1L..200L).map { BlinkSample(it, true) }) // eyes "closed" the whole window
        assertFalse(agg.snapshot().containsKey("longest_eye_closure_s"))
    }

    @Test fun stressComesFromTheNegativeExpressions() {
        live()
        agg.onExpression(mapOf("ANGRY" to 0.3f, "FEAR" to 0.1f, "HAPPY" to 0.9f, "NEUTRAL" to 0.2f))
        assertEquals(0.4, agg.snapshot()["emotion_stress"] as Double, 1e-6)
        agg.onExpression(mapOf("ANGRY" to 0.9f, "SAD" to 0.9f))
        assertEquals(1.0, agg.snapshot()["emotion_stress"] as Double, 1e-9) // clamped
    }

    @Test fun fieldsPresageCannotDeriveAreNeverSent() {
        live()
        agg.onPulse(70f, 0.9f)
        agg.onBlinks(listOf(BlinkSample(1, false)))
        agg.onExpression(mapOf("NEUTRAL" to 1f))
        val keys = agg.snapshot().keys
        for (k in listOf("yawns", "engagement", "gaze_off_road_s", "phone_in_hand", "hard_brakes", "swerves")) assertFalse(k, keys.contains(k))
    }

    @Test fun windowPayloadCarriesTheSnapshotAndStillHasGps() {
        live()
        agg.onPulse(70f, 0.9f)
        val body = WindowPayload.build(1_791_090_000_000L, emptyList(), agg.snapshot())
        assertEquals(70.0, body.getDouble("heart_rate"), 0.0)
        assertTrue(body.getBoolean("face_visible"))
        assertTrue(body.isNull("gps"))
        assertNull(body.opt("longest_eye_closure_s"))
    }
}
