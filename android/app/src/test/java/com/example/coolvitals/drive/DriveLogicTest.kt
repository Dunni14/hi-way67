package com.example.coolvitals.drive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveLogicTest {
    @Test fun levelCutoffs() {
        assertEquals(Level.GREAT, levelOf(0.24f))
        assertEquals(Level.GOOD, levelOf(0.25f))
        assertEquals(Level.GOOD, levelOf(0.49f))
        assertEquals(Level.OK, levelOf(0.5f))
        assertEquals(Level.OK, levelOf(0.74f))
        assertEquals(Level.BAD, levelOf(0.75f))
        assertEquals(Level.BAD, levelOf(1f))
        assertEquals(Level.GREAT, levelOf(null)) // no evidence
    }

    @Test fun customCutoffs() {
        val c = LevelCutoffs(great = 0.1f, good = 0.2f, ok = 0.3f)
        assertEquals(Level.BAD, levelOf(0.3f, c))
        assertEquals(Level.GOOD, levelOf(0.15f, c))
    }

    @Test fun microsleepForcesEyesBad() {
        assertEquals(Level.BAD, eyesLevel(0f, microsleep = true))
        assertEquals(Level.GOOD, eyesLevel(0.3f, microsleep = false))
    }

    @Test fun speedIsRedOnlyOverTheLimit() {
        assertFalse(isOverLimit(55, 55))
        assertFalse(isOverLimit(40, 55))
        assertTrue(isOverLimit(56, 55))
        assertFalse(isOverLimit(80, null)) // no limit, nothing to be over
        assertFalse(isOverLimit(null, 55))
    }

    @Test fun noLimitShowsDashes() {
        assertEquals("--", limitText(null, LimitSource.OSM))
        assertEquals("--", limitText(45, LimitSource.NONE)) // source none wins even if a number is present
        assertEquals("45", limitText(45, LimitSource.OSM))
        assertEquals("45", limitText(45, LimitSource.FALLBACK))
    }

    @Test fun fallbackDotOnlyForFallbackLimits() {
        assertTrue(showFallbackDot(LimitSource.FALLBACK, 45))
        assertFalse(showFallbackDot(LimitSource.OSM, 45))
        assertFalse(showFallbackDot(LimitSource.FALLBACK, null))
        assertFalse(showFallbackDot(LimitSource.NONE, null))
    }

    @Test fun tripStateAndPill() {
        assertEquals(TripState.NO_GPS, tripStateOf(permissionGranted = false, lastFixAgeMs = 100, speedMps = 20.0))
        assertEquals(TripState.NO_GPS, tripStateOf(true, null, null))
        assertEquals(TripState.NO_GPS, tripStateOf(true, FIX_STALE_MS + 1, 20.0))
        assertEquals(TripState.STOPPED, tripStateOf(true, 500, 0.4))
        assertEquals(TripState.DRIVING, tripStateOf(true, 500, 12.0))
        assertEquals("Driving" to "Monitoring", pillText(TripState.DRIVING))
        assertEquals("Stopped", pillText(TripState.STOPPED).first)
        assertEquals("No GPS" to null, pillText(TripState.NO_GPS))
    }

    @Test fun bearingHeldUnderThreeMetresPerSecond() {
        assertEquals(90.0, heldBearing(2.9, 270.0, 90.0)!!, 0.0) // slow: keep the old one
        assertEquals(270.0, heldBearing(3.0, 270.0, 90.0)!!, 0.0) // moving: follow course
        assertNull(heldBearing(1.0, 270.0, null)) // never moved: no bearing yet
        assertEquals(90.0, heldBearing(10.0, null, 90.0)!!, 0.0) // no course reported: keep
    }

    @Test fun fixFilterMatchesBackend() {
        assertTrue(isGoodFix(30f, 0f))
        assertFalse(isGoodFix(30.1f, 5f))
        assertFalse(isGoodFix(5f, -1f))
        assertFalse(isGoodFix(null, 5f))
        assertFalse(isGoodFix(5f, null))
    }

    @Test fun mphConversion() {
        assertEquals(52, mph(23.2))
        assertEquals(0, mph(0.0))
    }

    @Test fun sixBoxesAreThreeRowsAndGridGetsCapped() {
        assertEquals(2, boxRows(4))
        assertEquals(3, boxRows(6))
        assertEquals(1, boxRows(2))
        // 640 dp tall phone at 2x: grid may use what is left after header, nav, 3 gaps and the 200 dp map minimum
        val cap = gridMaxHeightPx(rootHeight = 1280, paddingTotal = 64, headerHeight = 192, navHeight = 128, gap = 24, mapMin = 400)
        assertEquals(1280 - 64 - 192 - 128 - 72 - 400, cap)
        assertEquals(0, gridMaxHeightPx(500, 64, 192, 128, 24, 400)) // never negative
    }

    @Test fun bannerByTier() {
        assertNull(bannerFor(0))
        assertEquals(3, (1..3).mapNotNull { bannerFor(it) }.size)
        assertNull(bannerFor(4))
    }

    @Test fun defaultBoxesFollowTheLevels() {
        val boxes = defaultBoxes(mapOf("distracted" to 0.1f, "phone" to 0.3f, "drowsy" to 0.9f), microsleep = false, speech = Level.GOOD)
        assertEquals(listOf("attention", "distraction", "eyes", "speech"), boxes.map { it.id })
        assertEquals(listOf(Level.GREAT, Level.GOOD, Level.BAD, Level.GOOD), boxes.map { it.level })
        assertTrue(boxes.all { it.onClick == null }) // static by default
    }

    @Test fun parsesTheBackendWindowResponse() {
        val r = WindowResult.fromJson(
            """{"score":71.2,"tier":2,"dominant":"reckless","actions":["voice_warning"],"override":"microsleep",
               "levels":{"drowsy":0.2,"agitated":0,"speeding":0.8,"phone":0,"distracted":0.4,"erratic":0},
               "degraded":false,"gps":{"ok":true,"speed_mps":20.1,"limit_mph":45,"limit_source":"fallback","stopped":false,"moving":true}}""",
        )
        assertEquals(2, r.tier)
        assertEquals(0.4f, r.levels["distracted"]!!, 1e-6f)
        assertTrue(r.microsleep)
        assertEquals(45, r.limitMph)
        assertEquals(LimitSource.FALLBACK, r.limitSource)
    }

    @Test fun responseWithoutGpsHasNoLimit() {
        val r = WindowResult.fromJson("""{"tier":0,"levels":{"drowsy":0},"override":null}""")
        assertNull(r.limitMph)
        assertEquals(LimitSource.NONE, r.limitSource)
        assertFalse(r.microsleep)
    }

    @Test fun limitNullInGpsBlock() {
        val r = WindowResult.fromJson("""{"tier":0,"levels":{},"gps":{"limit_mph":null,"limit_source":"none"}}""")
        assertNull(r.limitMph)
    }
}
