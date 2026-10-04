package dg.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** One finished trip as it appears in the Stats tab's history list. */
@Serializable
data class TripSummary(
    val endedAtMs: Long,
    val durationMin: Int,
    val grade: String,
    val avgRisk: Double,
    val peakRisk: Double,
    val alerts: Int, // spoken alerts across all tiers
    val demo: Boolean = false,
    // Null on trips saved before speeds were recorded, or when no speed reading came in.
    val avgSpeedMph: Double? = null,
    val topSpeedMph: Double? = null,
) {
    companion object {
        fun of(card: ReportCard, endedAtMs: Long, demo: Boolean, speed: SpeedTracker? = null) = TripSummary(
            endedAtMs, card.durationMin, card.grade, card.avgRisk, card.peakRisk, card.alertsByTier.values.sum(), demo,
            avgSpeedMph = speed?.avg, topSpeedMph = speed?.top,
        )
    }
}

/** Trip history kept on the phone: newest first, capped, stored as JSON. */
object TripHistory {
    const val MAX_TRIPS = 50
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(TripSummary.serializer())

    fun add(history: List<TripSummary>, trip: TripSummary): List<TripSummary> = (listOf(trip) + history).take(MAX_TRIPS)

    fun encode(history: List<TripSummary>): String = json.encodeToString(serializer, history)

    /** Missing or unreadable data is an empty history, never a crash. */
    fun decode(text: String?): List<TripSummary> =
        if (text.isNullOrBlank()) emptyList() else runCatching { json.decodeFromString(serializer, text) }.getOrDefault(emptyList())
}
