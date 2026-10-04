package dev.driverguardian.net

import android.net.Uri
import dg.core.DriverStats
import dg.core.History
import dg.core.TripCard
import dg.core.TripRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Reads trip history from the backend's risk REST API (stored on Tiger Data), on the same host:port
 * as the phone WebSocket. Trips are stored under the backend's driver id, which `/health` reports.
 */
class HistoryApi(private val host: () -> String) {
    private val http = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build()

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url("http://${host()}$path").build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code} for $path")
            r.body?.string().orEmpty()
        }
    }

    /** The driver id the backend stores trips under (its current driver name). */
    suspend fun driverName(): String? = History.driverNameFromHealth(get("/health"))

    suspend fun stats(driver: String): DriverStats = History.decodeStats(get("/drivers/${Uri.encode(driver)}/stats"))

    suspend fun trips(driver: String): List<TripRow> = History.decodeTrips(get("/drivers/${Uri.encode(driver)}/trips"))

    suspend fun card(tripId: String): TripCard = History.decodeCard(get("/trips/${Uri.encode(tripId)}/card"))
}
