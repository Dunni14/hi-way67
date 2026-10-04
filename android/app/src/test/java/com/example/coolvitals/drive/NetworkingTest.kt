package com.example.coolvitals.drive

import com.example.coolvitals.net.Backend
import com.example.coolvitals.net.HttpBackend
import com.example.coolvitals.net.WindowReply
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

private const val T0 = 1_791_090_000_000L // 2026-10-04T05:00:00Z
private fun fix(k: Int, speed: Double = 12.0, acc: Float = 6f) = DriveFix(speed, 90.0, T0 + k * 1000L, 42.28, -83.74 + k * 1e-4, acc)

class WindowPayloadTest {
    @Test fun fixesBecomeTheBackendFieldNames() {
        val body = WindowPayload.build(T0 + 9000, listOf(fix(0)))
        assertEquals("2026-10-04T05:00:09Z", body.getString("ts"))
        val f = body.getJSONObject("gps").getJSONArray("fixes").getJSONObject(0)
        assertEquals("2026-10-04T05:00:00Z", f.getString("t"))
        assertEquals(42.28, f.getDouble("lat"), 0.0)
        assertEquals(12.0, f.getDouble("speed_mps"), 0.0)
        assertEquals(90.0, f.getDouble("heading_deg"), 0.0)
        assertEquals(6.0, f.getDouble("h_accuracy_m"), 0.0)
    }

    @Test fun noGoodFixMeansGpsNull() {
        val body = WindowPayload.build(T0, emptyList())
        assertTrue(body.has("gps"))
        assertTrue(body.isNull("gps")) // explicit null, not absent: absent would mean a legacy payload
    }

    @Test fun neverMoreThanTenFixes() {
        val body = WindowPayload.build(T0, (0 until 25).map { fix(it) })
        assertEquals(10, body.getJSONObject("gps").getJSONArray("fixes").length())
    }

    @Test fun missingHeadingIsNull() {
        val f = WindowPayload.fixJson(fix(0).copy(courseDeg = null))
        assertTrue(f.isNull("heading_deg"))
    }

    @Test fun presageFieldsOnlyWhenSupplied() {
        val none = WindowPayload.build(T0, listOf(fix(0)))
        assertFalse(none.has("heart_rate"))
        assertFalse(none.has("face_visible"))
        val some = WindowPayload.build(T0, listOf(fix(0)), mapOf("heart_rate" to 71.0, "face_visible" to true, "yawns" to null))
        assertEquals(71.0, some.getDouble("heart_rate"), 0.0)
        assertTrue(some.getBoolean("face_visible"))
        assertFalse(some.has("yawns"))
    }
}

class FixBufferTest {
    @Test fun dropsBadFixesLikeTheBackend() {
        val b = FixBuffer()
        b.add(fix(0, acc = 31f))
        b.add(fix(1, speed = -1.0))
        b.add(fix(2, acc = 30f))
        assertEquals(listOf(T0 + 2000), b.drain().map { it.timeMs })
    }

    @Test fun keepsTheNewestTenOldestFirstAndEmpties() {
        val b = FixBuffer()
        (0 until 14).reversed().forEach { b.add(fix(it)) } // arrive out of order
        val out = b.drain()
        assertEquals((4 until 14).map { T0 + it * 1000L }, out.map { it.timeMs })
        assertTrue(b.drain().isEmpty())
    }
}

/** Minimal one-request-per-connection HTTP server (the unit-test classpath has no com.sun.net.httpserver). */
private class TinyServer(private val handler: (path: String, body: String) -> Pair<Int, String>) {
    private val socket = ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))
    val port get() = socket.localPort

    init {
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val c = try { socket.accept() } catch (_: java.io.IOException) { break }
                thread(isDaemon = true) {
                    c.use {
                        val input = it.getInputStream().buffered()
                        fun line(): String { val sb = StringBuilder(); while (true) { val ch = input.read(); if (ch < 0 || ch == '\n'.code) break; if (ch != '\r'.code) sb.append(ch.toChar()) }; return sb.toString() }
                        val path = line().split(' ').getOrElse(1) { "/" }
                        var len = 0
                        while (true) { val h = line(); if (h.isEmpty()) break; if (h.startsWith("Content-Length:", true)) len = h.substringAfter(':').trim().toInt() }
                        val body = ByteArray(len).also { b -> var n = 0; while (n < len) { val r = input.read(b, n, len - n); if (r < 0) break; n += r } }.decodeToString()
                        val (code, resp) = handler(path, body)
                        val bytes = resp.toByteArray()
                        it.getOutputStream().write("HTTP/1.1 $code X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray() + bytes)
                    }
                }
            }
        }
    }

    fun stop() = socket.close()
}

class HttpBackendTest {
    private var server: TinyServer? = null

    @After fun stop() {
        server?.stop()
    }

    private fun serve(handler: (path: String, body: String) -> Pair<Int, String>): HttpBackend {
        server?.stop()
        val s = TinyServer(handler)
        server = s
        return HttpBackend("http://127.0.0.1:${s.port}", timeoutMs = 400)
    }

    @Test fun startTripPostsDriverAndSharing() = runBlocking {
        var seen = ""
        val b = serve { path, body -> seen = "$path $body"; 201 to """{"trip_id":"t-1"}""" }
        assertEquals("t-1", b.startTrip("demo", false))
        assertEquals("/trips", seen.substringBefore(' '))
        val sent = JSONObject(seen.substringAfter(' '))
        assertEquals("demo", sent.getString("driver_id"))
        assertFalse(sent.getBoolean("share_location"))
    }

    @Test fun okWindowIsParsed() = runBlocking {
        val b = serve { _, _ -> 200 to """{"tier":2,"levels":{"drowsy":0.5},"override":null,"gps":{"limit_mph":45,"limit_source":"osm"}}""" }
        val r = b.postWindow("t-1", JSONObject().put("ts", "x")) as WindowReply.Ok
        assertEquals(2, r.result.tier)
        assertEquals(45, r.result.limitMph)
    }

    @Test fun endedTripIs409TripGone() = runBlocking {
        val b = serve { _, _ -> 409 to """{"error":"trip already ended"}""" }
        assertEquals(WindowReply.TripGone, b.postWindow("t-1", JSONObject()))
    }

    @Test fun duplicateTimestampOnlyLosesThatWindow() = runBlocking {
        val b = serve { _, _ -> 409 to """{"error":"duplicate window ts"}""" }
        assertTrue(b.postWindow("t-1", JSONObject()) is WindowReply.Failed)
    }

    @Test fun serverErrorAndGarbageAreFailuresNotCrashes() = runBlocking {
        assertTrue(serve { _, _ -> 500 to "oops" }.postWindow("t", JSONObject()) is WindowReply.Failed)
        assertTrue(serve { _, _ -> 200 to "not json" }.postWindow("t", JSONObject()) is WindowReply.Failed)
    }

    @Test fun slowBackendTimesOutQuickly() = runBlocking {
        val b = serve { _, _ -> Thread.sleep(1500); 200 to "{}" }
        val started = System.nanoTime()
        assertTrue(b.postWindow("t", JSONObject()) is WindowReply.Failed)
        assertTrue("timeout took ${(System.nanoTime() - started) / 1_000_000} ms", (System.nanoTime() - started) < 1_200_000_000L)
    }

    @Test fun unreachableBackend() = runBlocking {
        val b = HttpBackend("http://127.0.0.1:1", timeoutMs = 300)
        assertTrue(b.postWindow("t", JSONObject()) is WindowReply.Failed)
        try {
            b.startTrip("demo", true)
            throw AssertionError("expected IOException")
        } catch (_: IOException) {
        }
        b.endTrip("t") // must not throw
    }
}

class DriveSessionTest {
    private class Fake : Backend {
        var starts = 0
        var ends = mutableListOf<String>()
        var failStart = false
        var replies = ArrayDeque<WindowReply>()
        val bodies = mutableListOf<JSONObject>()

        override suspend fun startTrip(driverId: String, shareLocation: Boolean): String {
            if (failStart) throw IOException("down")
            return "trip-${++starts}"
        }

        override suspend fun postWindow(tripId: String, body: JSONObject): WindowReply {
            bodies += body
            return replies.removeFirstOrNull() ?: WindowReply.Ok(WindowResult(0, emptyMap(), false, null, LimitSource.NONE))
        }

        override suspend fun endTrip(tripId: String) {
            ends += tripId
        }
    }

    private fun session(b: Backend, results: MutableList<WindowResult> = mutableListOf(), conn: MutableList<Boolean> = mutableListOf()) =
        DriveSession(b, "demo", true, now = { T0 }, onResult = { results += it }, onConnection = { conn += it })

    @Test fun startsATripThenPostsOneWindowPerTickWithTheFixes() = runBlocking {
        val b = Fake()
        val results = mutableListOf<WindowResult>()
        val s = session(b, results)
        (0 until 10).forEach { s.onFix(fix(it)) }
        s.tick()
        (10 until 20).forEach { s.onFix(fix(it)) }
        s.tick()
        assertEquals(1, b.starts)
        assertEquals(2, b.bodies.size)
        assertEquals(10, b.bodies[0].getJSONObject("gps").getJSONArray("fixes").length())
        assertEquals(2, results.size)
        assertNotNull(s.currentTripId)
    }

    @Test fun windowTimestampsAlwaysIncrease() = runBlocking {
        val b = Fake()
        val s = session(b)
        s.tick() // no fixes: ts from the clock
        s.tick() // same clock value: must still be later
        val a = b.bodies.map { it.getString("ts") }
        assertEquals(2, a.size)
        assertTrue(java.time.Instant.parse(a[1]).isAfter(java.time.Instant.parse(a[0])))
    }

    @Test fun noFixesPostsGpsNull() = runBlocking {
        val b = Fake()
        session(b).tick()
        assertTrue(b.bodies.single().isNull("gps"))
    }

    @Test fun backendDownMeansOfflineThenRecovers() = runBlocking {
        val b = Fake().apply { failStart = true }
        val conn = mutableListOf<Boolean>()
        val s = session(b, conn = conn)
        s.tick()
        assertEquals(listOf(false), conn)
        assertTrue(b.bodies.isEmpty())
        b.failStart = false
        s.tick()
        assertEquals(listOf(false, true, true), conn)
        assertEquals(1, b.bodies.size)
    }

    @Test fun failedWindowIsDroppedAndNextOneGoesOut() = runBlocking {
        val b = Fake().apply { replies += WindowReply.Failed("HTTP 500") }
        val conn = mutableListOf<Boolean>()
        val s = session(b, conn = conn)
        s.tick()
        s.tick()
        assertEquals(2, b.bodies.size)
        assertEquals(1, b.starts) // same trip
        assertEquals(listOf(true, false, true), conn) // start ok, window lost, next window ok
    }

    @Test fun backendEndedTripStopsSendingUntilTheDriverMovesAgain() = runBlocking {
        val ended = WindowReply.Ok(WindowResult(0, emptyMap(), false, null, LimitSource.NONE, tripEnded = true))
        val b = Fake().apply { replies += ended }
        val s = session(b)
        s.onFix(fix(0, speed = 0.2))
        s.tick() // trip 1, ends
        assertNull(s.currentTripId)
        s.onFix(fix(1, speed = 0.2))
        s.tick()
        s.tick()
        assertEquals(1, b.bodies.size) // idle: nothing sent while stopped
        s.onFix(fix(2, speed = 9.0))
        s.tick() // moving again: a new trip
        assertEquals(2, b.starts)
        assertEquals(2, b.bodies.size)
        assertEquals(1, b.bodies.last().getJSONObject("gps").getJSONArray("fixes").length()) // the stopped fix was not kept
    }

    @Test fun a409TripGoneAlsoGoesIdle() = runBlocking {
        val b = Fake().apply { replies += WindowReply.TripGone }
        val s = session(b)
        s.tick()
        assertNull(s.currentTripId)
        s.tick()
        assertEquals(1, b.bodies.size)
    }

    @Test fun pausedPostsNothing() = runBlocking {
        val b = Fake()
        val s = session(b)
        s.paused = true
        s.tick()
        assertEquals(0, b.starts)
        s.paused = false
        s.tick()
        assertEquals(1, b.bodies.size)
    }

    @Test fun stopEndsTheOpenTripOnce() = runBlocking {
        val b = Fake()
        val s = session(b)
        s.tick()
        s.stop()
        s.stop()
        assertEquals(listOf("trip-1"), b.ends)
    }
}
