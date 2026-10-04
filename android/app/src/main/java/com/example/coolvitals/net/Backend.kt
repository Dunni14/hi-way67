package com.example.coolvitals.net

import com.example.coolvitals.drive.WindowResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** How one window post went. Nothing here throws: the Drive screen must keep working with the backend down. */
sealed interface WindowReply {
    data class Ok(val result: WindowResult) : WindowReply

    /** 409: the trip already ended on the backend. Stop sending to it. */
    data object TripGone : WindowReply

    data class Failed(val reason: String) : WindowReply
}

/** The REST calls the phone makes (docs/risk-engine.md). An interface so the session is testable without a network. */
interface Backend {
    /** Creates the trip; returns its id. Throws [IOException] when the backend cannot be reached or refuses. */
    suspend fun startTrip(driverId: String, shareLocation: Boolean): String

    suspend fun postWindow(tripId: String, body: JSONObject): WindowReply

    /** Best effort. */
    suspend fun endTrip(tripId: String)
}

/** `HttpURLConnection` on the IO dispatcher: no extra dependency, short timeouts. */
class HttpBackend(baseUrl: String, private val timeoutMs: Int = 5_000) : Backend {
    private val base = baseUrl.trimEnd('/')

    private data class Response(val code: Int, val body: String)

    private fun request(method: String, path: String, json: JSONObject?): Response {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Accept", "application/json")
            if (json != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(json.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            return Response(code, stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally {
            conn.disconnect()
        }
    }

    override suspend fun startTrip(driverId: String, shareLocation: Boolean): String = withContext(Dispatchers.IO) {
        val r = request("POST", "/trips", JSONObject().put("driver_id", driverId).put("share_location", shareLocation))
        if (r.code != 201 && r.code != 200) throw IOException("POST /trips -> HTTP ${r.code}")
        JSONObject(r.body).optString("trip_id").ifEmpty { throw IOException("POST /trips: no trip_id in response") }
    }

    override suspend fun postWindow(tripId: String, body: JSONObject): WindowReply = withContext(Dispatchers.IO) {
        try {
            val r = request("POST", "/trips/$tripId/windows", body)
            when {
                r.code == 200 -> WindowReply.Ok(WindowResult.fromJson(r.body))
                r.code == 409 && r.body.contains("ended") -> WindowReply.TripGone
                // 409 "duplicate window ts" and anything else: this window is lost, the next one is fine.
                else -> WindowReply.Failed("HTTP ${r.code}")
            }
        } catch (e: IOException) {
            WindowReply.Failed(e.message ?: e.javaClass.simpleName)
        } catch (e: org.json.JSONException) {
            WindowReply.Failed("bad response: ${e.message}")
        }
    }

    override suspend fun endTrip(tripId: String) {
        withContext(Dispatchers.IO) {
            try {
                request("POST", "/trips/$tripId/end", null)
            } catch (_: IOException) {
            }
        }
    }
}
