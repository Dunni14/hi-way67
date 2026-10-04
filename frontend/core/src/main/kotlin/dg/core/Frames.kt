package dg.core

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Mirrors backend/src/ws/protocol.ts field for field.

val FrameJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

@Serializable
enum class SharingMode {
    @SerialName("always") ALWAYS,
    @SerialName("high_only") HIGH_ONLY,
    @SerialName("never") NEVER,
}

@Serializable
enum class Dominant {
    @SerialName("drowsy") DROWSY,
    @SerialName("reckless") RECKLESS,
}

/** Exact strings the backend keys on. */
object DriverEvent {
    const val YAWN = "yawn"
    const val NOD = "nod"
    const val HARD_BRAKE = "hard_brake"
    const val SWERVE = "swerve"
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed interface PhoneFrame {
    @Serializable @SerialName("hello")
    data class Hello(
        val driverName: String? = null,
        val sharingMode: SharingMode = SharingMode.HIGH_ONLY,
        val kidsInCar: Boolean = false,
    ) : PhoneFrame

    @Serializable @SerialName("settings")
    data class Settings(val sharingMode: SharingMode? = null, val kidsInCar: Boolean? = null) : PhoneFrame

    @Serializable @SerialName("trip_start")
    data object TripStart : PhoneFrame

    @Serializable @SerialName("trip_end")
    data object TripEnd : PhoneFrame

    /** One 10 s window of raw signals. The backend's risk engine scores it and decides every alert. */
    @Serializable @SerialName("risk_window")
    data class RiskWindow(
        val ts: Long, // epoch ms, real time, end of the window
        val speed: Double = 0.0,
        val lat: Double? = null,
        val lon: Double? = null,
        val events: List<String> = emptyList(),
        val signals: WindowSignals = WindowSignals(),
    ) : PhoneFrame

    /** Speech-to-text result. [context] echoes the `speak.context` we listened after, or "free". */
    @Serializable @SerialName("utterance")
    data class Utterance(val text: String, val context: String = SpeakContext.FREE) : PhoneFrame

    /** Finished playing a `speak` (and its listen window). */
    @Serializable @SerialName("speak_done")
    data class SpeakDone(val id: String) : PhoneFrame

    /** PNG (base64) of the end-of-trip summary card, sent right after `trip_end` for the backend to pass on to the contacts. */
    @Serializable @SerialName("trip_recap")
    data class RecapImage(val image: String) : PhoneFrame
}

/** Raw signals for one window, named like the risk engine's SignalWindow. Null = unknown (left out of the JSON). */
@Serializable
data class WindowSignals(
    @SerialName("face_visible") val faceVisible: Boolean? = null,
    @SerialName("heart_rate") val heartRate: Double? = null,
    @SerialName("breathing_rate") val breathingRate: Double? = null,
    val engagement: Double? = null,
    @SerialName("eye_closure_frac") val eyeClosureFrac: Double? = null,
    @SerialName("longest_eye_closure_s") val longestEyeClosureS: Double? = null,
    val yawns: Int? = null,
    @SerialName("emotion_stress") val emotionStress: Double? = null,
    @SerialName("gaze_off_road_s") val gazeOffRoadS: Double? = null,
    @SerialName("phone_in_hand") val phoneInHand: Boolean? = null,
    @SerialName("hard_brakes") val hardBrakes: Int? = null,
    val swerves: Int? = null,
    @SerialName("speed_mph") val speedMph: Double? = null,
    @SerialName("speed_limit_mph") val speedLimitMph: Double? = null,
)

/** `context` values of `speak` / `utterance`, as in protocol.ts. */
object SpeakContext {
    const val CHECKIN = "checkin"
    const val AFTER_MESSAGE = "after_message"
    const val PERMISSION = "permission"
    const val ROAST = "roast"
    const val INFO = "info"
    const val FREE = "free"
}

/** Backend -> phone. Parsed leniently so unknown frames never crash the app. */
sealed interface BackendFrame {
    /** Driver said "I'm fine"; the engine eased [factor]'s weight for this driver to [multiplier]. */
    data class Dismissed(val factor: String? = null, val multiplier: Double? = null) : BackendFrame

    /** The risk engine's verdict on the risk_window with the same [ts]. Tier is 0..3. */
    data class Evaluation(
        val ts: Long,
        val score: Double,
        val tier: Int,
        val dominant: Dominant,
        val levels: Map<String, Double>,
        val override: String?,
        val degraded: Boolean,
        val actions: List<String>,
        val calibrating: Boolean,
    ) : BackendFrame
    data class Navigate(val query: String) : BackendFrame
    data class Error(val message: String) : BackendFrame
    /** A line to say to the driver. [audio] is base64 mp3, empty if TTS failed (fall back to on-device TTS). */
    data class Speak(
        val id: String,
        val text: String,
        val tier: Int,
        val audio: String,
        val listenAfterMs: Long,
        val context: String,
    ) : BackendFrame
    data class Unknown(val type: String?) : BackendFrame
}

fun encodeFrame(frame: PhoneFrame): String = FrameJson.encodeToString(PhoneFrame.serializer(), frame)

fun decodeBackendFrame(text: String): BackendFrame {
    val obj: JsonObject = try {
        FrameJson.parseToJsonElement(text).jsonObject
    } catch (e: Exception) {
        return BackendFrame.Unknown(null)
    }
    fun str(key: String) = obj[key]?.jsonPrimitive?.contentOrNull
    fun num(key: String) = str(key)?.toDoubleOrNull()
    return when (val type = str("type")) {
        "dismissed" -> BackendFrame.Dismissed(str("factor"), num("multiplier"))
        "evaluation" -> BackendFrame.Evaluation(
            ts = num("ts")?.toLong() ?: 0L,
            score = num("score") ?: 0.0,
            tier = num("tier")?.toInt() ?: 0,
            dominant = if (str("dominant") == "reckless") Dominant.RECKLESS else Dominant.DROWSY,
            levels = (obj["levels"] as? JsonObject)?.mapNotNull { (k, v) -> v.jsonPrimitive.contentOrNull?.toDoubleOrNull()?.let { k to it } }?.toMap().orEmpty(),
            override = str("override"),
            degraded = str("degraded") == "true",
            actions = (obj["actions"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
            calibrating = str("calibrating") == "true",
        )
        "navigate" -> BackendFrame.Navigate(str("query") ?: "rest stop")
        "error" -> BackendFrame.Error(str("message") ?: "")
        "speak" -> {
            val id = str("id") ?: return BackendFrame.Unknown(type)
            BackendFrame.Speak(
                id = id,
                text = str("text") ?: "",
                tier = str("tier")?.toDoubleOrNull()?.toInt() ?: 0,
                audio = str("audio") ?: "",
                listenAfterMs = str("listenAfterMs")?.toDoubleOrNull()?.toLong() ?: 0L,
                context = str("context") ?: SpeakContext.INFO,
            )
        }
        else -> BackendFrame.Unknown(type)
    }
}

/** Capped exponential backoff, 1 s -> 30 s. */
class ReconnectPolicy(private val baseMs: Long = 1_000, private val maxMs: Long = 30_000) {
    private var attempt = 0
    fun nextDelayMs(): Long = minOf(maxMs, baseMs shl minOf(attempt++, 20))
    fun reset() { attempt = 0 }
}

/** Close code the backend uses when a newer phone connection replaces this one. Do not reconnect. */
const val CLOSE_REPLACED = 4000
