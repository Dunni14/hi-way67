package dev.driverguardian.net

import dev.driverguardian.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/** Direct ElevenLabs calls from the phone: TTS when a `speak` frame has no audio, Scribe for STT. */
class ElevenLabs(
    private val apiKey: String = BuildConfig.ELEVENLABS_API_KEY,
    private val voiceId: String = BuildConfig.ELEVENLABS_VOICE_ID,
) {
    private val http = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    val configured get() = apiKey.isNotBlank()

    /** mp3 bytes for [text]. */
    suspend fun speak(text: String): ByteArray = withContext(Dispatchers.IO) {
        check(configured) { "ELEVENLABS_API_KEY not set" }
        val body = JSONObject()
            .put("text", text)
            .put("model_id", "eleven_flash_v2_5")
            .toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url("https://api.elevenlabs.io/v1/text-to-speech/$voiceId?output_format=mp3_44100_128")
            .header("xi-api-key", apiKey)
            .post(body).build()
        http.newCall(req).execute().use { res ->
            check(res.isSuccessful) { "ElevenLabs TTS ${res.code}: ${res.body?.string()?.take(200)}" }
            res.body!!.bytes()
        }
    }

    /** Transcript of a recorded audio file (Scribe). */
    suspend fun transcribe(audio: File): String = withContext(Dispatchers.IO) {
        check(configured) { "ELEVENLABS_API_KEY not set" }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("model_id", "scribe_v1")
            .addFormDataPart("file", audio.name, audio.asRequestBody("audio/mp4".toMediaType()))
            .build()
        val req = Request.Builder()
            .url("https://api.elevenlabs.io/v1/speech-to-text")
            .header("xi-api-key", apiKey)
            .post(body).build()
        http.newCall(req).execute().use { res ->
            check(res.isSuccessful) { "ElevenLabs STT ${res.code}: ${res.body?.string()?.take(200)}" }
            JSONObject(res.body!!.string()).optString("text", "").trim()
        }
    }
}
