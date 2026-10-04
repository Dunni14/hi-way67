package dg.core

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
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

    @Serializable @SerialName("risk_window")
    data class RiskWindow(
        val ts: Long,
        @SerialName("R") val risk: Double,
        val drowsy: Double,
        val reckless: Double,
        val speed: Double = 0.0,
        val lat: Double? = null,
        val lon: Double? = null,
        val events: List<String> = emptyList(),
        val features: Map<String, Double>? = null,
    ) : PhoneFrame

    @Serializable @SerialName("alert")
    data class Alert(val tier: Int, val dominant: Dominant, @SerialName("R") val risk: Double) : PhoneFrame

    /** Speech-to-text result. `context` echoes the `speak.context` we listened after, or "free". */
    @Serializable @SerialName("utterance")
    data class Utterance(val text: String, val context: String = "free") : PhoneFrame

    /** Finished playing a `speak` (and its listen window). */
    @Serializable @SerialName("speak_done")
    data class SpeakDone(val id: String) : PhoneFrame
}

/** Backend -> phone. Parsed leniently so unknown frames never crash the app. */
sealed interface BackendFrame {
    data object Dismissed : BackendFrame
    data class Navigate(val query: String) : BackendFrame
    data class Error(val message: String) : BackendFrame
    /** `audio` is base64 mp3, or "" when the backend's TTS failed (phone then calls ElevenLabs itself). */
    data class Speak(
        val id: String, val text: String, val tier: Int, val audio: String,
        val listenAfterMs: Long, val context: String,
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
    return when (val type = obj["type"]?.jsonPrimitive?.contentOrNull) {
        "dismissed" -> BackendFrame.Dismissed
        "navigate" -> BackendFrame.Navigate(obj["query"]?.jsonPrimitive?.contentOrNull ?: "rest stop")
        "error" -> BackendFrame.Error(obj["message"]?.jsonPrimitive?.contentOrNull ?: "")
        "speak" -> BackendFrame.Speak(
            id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return BackendFrame.Unknown(type),
            text = obj["text"]?.jsonPrimitive?.contentOrNull ?: "",
            tier = obj["tier"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
            audio = obj["audio"]?.jsonPrimitive?.contentOrNull ?: "",
            listenAfterMs = obj["listenAfterMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            context = obj["context"]?.jsonPrimitive?.contentOrNull ?: "free",
        )
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
