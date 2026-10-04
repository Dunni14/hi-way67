package com.example.coolvitals.drive

import com.example.coolvitals.net.HttpBackend
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Opt-in: replays the backend's synthetic GPX drive through the real [DriveSession] and [HttpBackend] against a
 * running backend. Skipped unless BACKEND_URL is set.
 *   (backend)  PORT=8799 FAKE_DB=1 NO_SPECTRUM=1 npx tsx src/index.ts
 *   (android)  BACKEND_URL=http://127.0.0.1:8799 ./gradlew :app:testDebugUnitTest --tests '*BackendIntegrationTest'
 */
class BackendIntegrationTest {
    private fun rad(d: Double) = Math.toRadians(d)

    private fun distance(a: DoubleArray, b: DoubleArray): Double {
        val dLat = rad(b[0] - a[0]); val dLon = rad(b[1] - a[1])
        val h = sin(dLat / 2).let { it * it } + cos(rad(a[0])) * cos(rad(b[0])) * sin(dLon / 2).let { it * it }
        return 2 * 6_371_000 * atan2(sqrt(h), sqrt(1 - h))
    }

    private fun bearing(a: DoubleArray, b: DoubleArray): Double {
        val y = sin(rad(b[1] - a[1])) * cos(rad(b[0]))
        val x = cos(rad(a[0])) * sin(rad(b[0])) - sin(rad(a[0])) * cos(rad(b[0])) * cos(rad(b[1] - a[1]))
        return (Math.toDegrees(atan2(y, x)) + 360) % 360
    }

    /** Speed from distance over time and heading from the bearing, the same way the backend's GPX reader does. */
    private fun fixesFromGpx(xml: String): List<DriveFix> {
        val pts = Regex("""<trkpt lat="([-\d.]+)" lon="([-\d.]+)"><time>([^<]+)</time>""").findAll(xml)
            .map { Triple(doubleArrayOf(it.groupValues[1].toDouble(), it.groupValues[2].toDouble()), Instant.parse(it.groupValues[3]).toEpochMilli(), 0) }.toList()
        return pts.mapIndexed { i, p ->
            val (a, b) = if (i > 0) pts[i - 1] to p else p to (pts.getOrNull(1) ?: p)
            val dt = (b.second - a.second) / 1000.0
            val speed = if (dt > 0) distance(a.first, b.first) / dt else 0.0
            val moved = a.first[0] != b.first[0] || a.first[1] != b.first[1]
            DriveFix(speed, if (moved) bearing(a.first, b.first) else null, p.second, p.first[0], p.first[1], 5f)
        }
    }

    @Test fun replayDriveThroughTheRealBackend() = runBlocking {
        val url = System.getenv("BACKEND_URL")
        assumeTrue("BACKEND_URL not set", !url.isNullOrBlank())
        val gpx = File("../../backend/src/gps/fixtures/drive.gpx")
        assumeTrue("drive.gpx not found from ${File(".").absolutePath}", gpx.exists())
        val fixes = fixesFromGpx(gpx.readText())
        assertEquals(561, fixes.size)

        val results = mutableListOf<WindowResult>()
        val online = mutableListOf<Boolean>()
        val session = DriveSession(HttpBackend(url!!), "android-it", shareLocation = true, onResult = { results += it }, onConnection = { online += it })

        var tripId: String? = null
        for (chunk in fixes.chunked(10)) {
            chunk.forEach { session.onFix(it) }
            session.tick()
            tripId = tripId ?: session.currentTripId
        }

        assertNotNull("a trip was created", tripId)
        assertTrue("every post reached the backend", online.all { it })
        assertTrue("windows were scored (${results.size})", results.size >= 50)
        assertTrue("the backend ended the trip after the long stop", results.any { it.tripEnded })
        assertEquals("nothing posted after the trip ended (stopped, so idle)", results.indexOfFirst { it.tripEnded }, results.size - 1)
        session.stop()
    }
}
