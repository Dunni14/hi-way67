package dev.driverguardian.net

import dg.core.Evaluation
import dg.core.FeedbackBody
import dg.core.FeedbackResult
import dg.core.RestCodec
import dg.core.ServerReport
import dg.core.SharingMode
import dg.core.SignalWindowBody
import dg.core.TripStartBody
import dg.core.TripSummary
import dg.core.Verdict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Non-2xx answer from the backend. 404 on `/trips` usually means `DATABASE_URL` is unset (engine off). */
class RiskApiException(val status: Int, message: String) : IOException("HTTP $status: $message")

/**
 * REST client for the backend risk engine (docs/risk-engine.md), same host:port as the WebSocket.
 * Every call is a suspend function that runs on IO and throws [IOException] or [RiskApiException].
 */
class RiskApi(private val host: () -> String) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()

    suspend fun startTrip(
        driverId: String, kidsInCar: Boolean, lowExperience: Boolean, sleepHours: Double?, sharing: SharingMode,
    ): String = RestCodec.started(
        post("/trips", RestCodec.encode(TripStartBody(driverId, kidsInCar, lowExperience, sleepHours, sharing))),
    ).tripId

    suspend fun sendWindow(tripId: String, w: SignalWindowBody): Evaluation =
        RestCodec.evaluation(post("/trips/$tripId/windows", RestCodec.encode(w)))

    suspend fun feedback(tripId: String, windowTs: String, verdict: Verdict): FeedbackResult =
        RestCodec.feedback(post("/trips/$tripId/feedback", RestCodec.encode(FeedbackBody(windowTs, verdict))))

    suspend fun endTrip(tripId: String) { post("/trips/$tripId/end", "{}") }

    suspend fun report(tripId: String): ServerReport = RestCodec.report(get("/trips/$tripId/report"))

    suspend fun driverTrips(driverId: String): List<TripSummary> =
        RestCodec.trips(get("/drivers/${URLEncoder.encode(driverId, "UTF-8").replace("+", "%20")}/trips"))

    private suspend fun get(path: String) = call(Request.Builder().url(url(path)).get().build())
    private suspend fun post(path: String, body: String) =
        call(Request.Builder().url(url(path)).post(body.toRequestBody(json)).build())

    private fun url(path: String) = "http://${host()}$path"

    private suspend fun call(req: Request): String = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw RiskApiException(r.code, text.take(200))
            text
        }
    }
}
