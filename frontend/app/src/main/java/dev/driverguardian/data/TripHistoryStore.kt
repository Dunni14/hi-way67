package dev.driverguardian.data

import android.content.Context
import dg.core.TripHistory
import dg.core.TripSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Finished trips, kept in a small JSON file in the app's private storage. */
class TripHistoryStore(context: Context) {
    private val file = File(context.filesDir, "trip_history.json")

    suspend fun load(): List<TripSummary> = withContext(Dispatchers.IO) {
        TripHistory.decode(runCatching { file.readText() }.getOrNull())
    }

    suspend fun save(history: List<TripSummary>) {
        withContext(Dispatchers.IO) { runCatching { file.writeText(TripHistory.encode(history)) } }
    }
}
