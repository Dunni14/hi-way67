package dg.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.time.Instant

// Mirrors backend/src/risk/types.ts and the REST routes in backend/src/http/risk.ts.
// Field names are the backend's snake_case names.

/** One 10 s signal window for `POST /trips/{id}/windows`. Null = signal not measured. */
@Serializable
data class SignalWindowBody(
    val ts: String, // ISO 8601, end of the window
    @SerialName("face_visible") val faceVisible: Boolean? = null,
    @SerialName("heart_rate") val heartRate: Double? = null,
    @SerialName("breathing_rate") val breathingRate: Double? = null,
    val engagement: Double? = null,
    @SerialName("eye_closure_frac") val eyeClosureFrac: Double? = null,
    @SerialName("longest_eye_closure_s") val longestEyeClosureS: Double? = null,
    val yawns: Double? = null,
    @SerialName("emotion_stress") val emotionStress: Double? = null,
    @SerialName("gaze_off_road_s") val gazeOffRoadS: Double? = null,
    @SerialName("phone_in_hand") val phoneInHand: Boolean? = null,
    @SerialName("hard_brakes") val hardBrakes: Double? = null,
    val swerves: Double? = null,
    @SerialName("speed_mph") val speedMph: Double? = null,
    @SerialName("speed_limit_mph") val speedLimitMph: Double? = null,
)

@Serializable
data class TripStartBody(
    @SerialName("driver_id") val driverId: String,
    @SerialName("kids_in_car") val kidsInCar: Boolean = false,
    @SerialName("low_experience") val lowExperience: Boolean = false,
    @SerialName("sleep_hours") val sleepHours: Double? = null,
    @SerialName("sharing_mode") val sharingMode: SharingMode? = null,
)

@Serializable
data class TripStarted(@SerialName("trip_id") val tripId: String)

@Serializable
enum class Verdict {
    @SerialName("false_alarm") FALSE_ALARM,
    @SerialName("confirmed") CONFIRMED,
}

@Serializable
data class FeedbackBody(@SerialName("window_ts") val windowTs: String, val verdict: Verdict)

@Serializable
data class FeedbackResult(val factor: String, val multiplier: Double)

/** Action strings the engine returns. Unknown ones are ignored, so a newer backend never breaks parsing. */
object RiskAction {
    const val VOICE_NUDGE = "voice_nudge"
    const val VOICE_WARNING = "voice_warning"
    const val VOICE_URGENT = "voice_urgent"
    const val NOTIFY_CONTACTS = "notify_contacts"
    const val ASK_PERMISSION = "ask_permission_to_notify"
}

/** Engine verdict for one window (`tier` 0..3). */
@Serializable
data class Evaluation(
    val score: Double,
    val tier: Int,
    val dominant: String, // "drowsy" | "reckless"
    val actions: List<String> = emptyList(),
    val levels: Map<String, Double> = emptyMap(), // drowsy, agitated, speeding, phone, distracted, erratic
    val override: String? = null, // microsleep, drowsy_sustained_3, ...
    val degraded: Boolean = false, // face not visible or signals missing
) {
    val wantsAlarm get() = RiskAction.VOICE_URGENT in actions
    val wantsPermission get() = RiskAction.ASK_PERMISSION in actions
    val notifiedContacts get() = RiskAction.NOTIFY_CONTACTS in actions
}

@Serializable
data class ServerPoint(val ts: String, val score: Double, val tier: Int)

@Serializable
data class ServerEvent(val ts: String, val tier: Int, val actions: List<String> = emptyList(), val override: String? = null)

/** `GET /trips/{id}/report`. Grade is A (never above tier 0) to D (reached tier 3). */
@Serializable
data class ServerReport(
    @SerialName("trip_id") val tripId: String,
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    val series: List<ServerPoint> = emptyList(),
    @SerialName("max_score") val maxScore: Double = 0.0,
    @SerialName("time_in_tier_s") val timeInTierS: Map<String, Double> = emptyMap(),
    val grade: String = "A",
    val events: List<ServerEvent> = emptyList(),
) {
    val durationMin: Int get() = ((timeInTierS.values.sum() + 59) / 60).toInt().coerceAtLeast(1)
}

/** One row of `GET /drivers/{id}/trips`. */
@Serializable
data class TripSummary(
    @SerialName("trip_id") val tripId: String,
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("max_score") val maxScore: Double = 0.0,
    val grade: String = "A",
)

object RestCodec {
    fun encode(b: SignalWindowBody) = FrameJson.encodeToString(SignalWindowBody.serializer(), b)
    fun encode(b: TripStartBody) = FrameJson.encodeToString(TripStartBody.serializer(), b)
    fun encode(b: FeedbackBody) = FrameJson.encodeToString(FeedbackBody.serializer(), b)
    fun evaluation(s: String) = FrameJson.decodeFromString(Evaluation.serializer(), s)
    fun started(s: String) = FrameJson.decodeFromString(TripStarted.serializer(), s)
    fun feedback(s: String) = FrameJson.decodeFromString(FeedbackResult.serializer(), s)
    fun report(s: String) = FrameJson.decodeFromString(ServerReport.serializer(), s)
    fun trips(s: String) = FrameJson.decodeFromString(ListSerializer(TripSummary.serializer()), s)

    fun iso(epochMs: Long): String = Instant.ofEpochMilli(epochMs).toString()
}

/** Label for the engine's tiers (0..3). */
fun tierLabel(tier: Int) = when (tier) { 1 -> "Nudge"; 2 -> "Warning"; 3 -> "Urgent"; else -> "OK" }

/** Label for the engine's override codes. */
fun overrideLabel(code: String) = when (code) {
    "microsleep" -> "Microsleep"
    "drowsy_sustained_3" -> "Drowsy for 3 windows"
    "drowsy_sustained_12" -> "Drowsy for 2 min"
    "tier2_sustained_12" -> "Warning held for 2 min"
    else -> code
}
