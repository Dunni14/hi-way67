package dg.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

// Trip history from the backend's risk engine (stored on Tiger Data):
//   GET /drivers/{driver}/trips -> List<TripRow>     newest first
//   GET /trips/{id}/card        -> TripCard          persisted report card (or live, while the trip runs)
//   GET /health                 -> .driverName       the driver id trips are stored under
// Numbers are decoded as Double: the backend may send 3 or 3.0. Unknown fields are ignored.

@Serializable
data class TripRow(
    @SerialName("trip_id") val tripId: String,
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("max_score") val maxScore: Double = 0.0,
    val grade: String? = null,
    @SerialName("card_score") val cardScore: Double? = null,
    @SerialName("card_grade") val cardGrade: String? = null,
) {
    /** The report card's grade when there is one, else the max-tier grade. */
    val displayGrade: String get() = cardGrade ?: grade ?: "?"
}

@Serializable
data class CardPoint(val ts: String, val score: Double = 0.0, val tier: Int = 0)

@Serializable
data class CardMetrics(
    @SerialName("duration_s") val durationS: Double = 0.0,
    @SerialName("night_trip") val nightTrip: Boolean = false,
    @SerialName("distance_mi") val distanceMi: Double = 0.0,
    @SerialName("avg_speed_mph") val avgSpeedMph: Double = 0.0,
    @SerialName("max_speed_mph") val maxSpeedMph: Double = 0.0,
    @SerialName("max_risk") val maxRisk: Double = 0.0,
    @SerialName("max_tier") val maxTier: Int = 0,
    @SerialName("tier_seconds") val tierSeconds: List<Double> = emptyList(),
    val yawns: Double = 0.0,
    @SerialName("longest_eye_closure_s") val longestEyeClosureS: Double = 0.0,
    val interventions: Map<String, Double> = emptyMap(),
    val overrides: Map<String, Double> = emptyMap(),
)

@Serializable
data class CardCounts(
    @SerialName("hard_brakes") val hardBrakes: Double = 0.0,
    val swerves: Double = 0.0,
)

@Serializable
data class TripCard(
    val score: Double = 0.0,
    val grade: String = "?",
    val provisional: Boolean = false,
    val metrics: CardMetrics = CardMetrics(),
    val counts: CardCounts = CardCounts(),
    val series: List<CardPoint> = emptyList(),
)

object History {
    fun decodeTrips(json: String): List<TripRow> = FrameJson.decodeFromString(ListSerializer(TripRow.serializer()), json)
    fun decodeCard(json: String): TripCard = FrameJson.decodeFromString(TripCard.serializer(), json)

    /** The backend's driver id from GET /health, or null. */
    fun driverNameFromHealth(json: String): String? = runCatching {
        FrameJson.parseToJsonElement(json).let { (it as kotlinx.serialization.json.JsonObject)["driverName"] }
            ?.let { (it as kotlinx.serialization.json.JsonPrimitive).content }
    }.getOrNull()?.takeIf { it.isNotBlank() && it != "null" }

    /** Alerts the engine fired in a trip, by kind, in plain words, skipping zeros. */
    fun alertSummary(card: TripCard): List<Pair<String, Int>> {
        val names = linkedMapOf(
            "voice_urgent" to "Urgent warnings", "voice_warning" to "Warnings", "voice_nudge" to "Check-ins",
            "notify_contacts" to "Contacts alerted", "ask_permission_to_notify" to "Asked to notify",
        )
        return names.mapNotNull { (k, label) -> card.metrics.interventions[k]?.toInt()?.takeIf { it > 0 }?.let { label to it } }
    }

    /** Why tiers were forced, in plain words, skipping zeros. */
    fun overrideSummary(card: TripCard): List<Pair<String, Int>> {
        val names = mapOf(
            "microsleep" to "Eyes closed too long", "drowsy_sustained_3" to "Drowsy for 30 s",
            "drowsy_sustained_12" to "Drowsy for 2 min", "tier2_sustained_12" to "Warning ignored",
        )
        return card.metrics.overrides.mapNotNull { (k, v) -> v.toInt().takeIf { it > 0 }?.let { (names[k] ?: k) to it } }
    }
}
