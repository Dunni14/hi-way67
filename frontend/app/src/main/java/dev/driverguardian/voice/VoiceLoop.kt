package dev.driverguardian.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import dev.driverguardian.net.ElevenLabs
import dg.core.BackendFrame
import dg.core.PhoneFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/**
 * Closes the voice loop from PROTOCOL.md: play each `speak` (backend audio, else ElevenLabs TTS),
 * listen for `listenAfterMs` and transcribe with ElevenLabs Scribe, send `utterance`, then `speak_done`.
 * Speaks are handled strictly one at a time.
 */
class VoiceLoop(
    private val context: Context,
    scope: CoroutineScope,
    private val send: (PhoneFrame) -> Unit,
    private val eleven: ElevenLabs = ElevenLabs(),
) {
    private val queue = Channel<BackendFrame.Speak>(Channel.UNLIMITED)
    private val _listening = MutableStateFlow(false)
    val listening: StateFlow<Boolean> = _listening

    init {
        scope.launch {
            for (s in queue) {
                try { handle(s) } catch (e: Exception) { Log.w(TAG, "speak ${s.id} failed", e) }
                send(PhoneFrame.SpeakDone(s.id)) // always, so the backend's queue never stalls
            }
        }
    }

    fun onSpeak(s: BackendFrame.Speak) { queue.trySend(s) }

    /** Push-to-talk: listen once and send a `free` utterance. */
    suspend fun pushToTalk() {
        if (_listening.value) return
        listenAndSend("free", 8_000)
    }

    private suspend fun handle(s: BackendFrame.Speak) {
        val mp3 = if (s.audio.isNotEmpty()) Base64.decode(s.audio, Base64.DEFAULT)
        else if (s.text.isNotBlank()) runCatching { eleven.speak(s.text) }
            .onFailure { Log.w(TAG, "ElevenLabs TTS failed", it) }.getOrNull()
        else null
        if (mp3 != null) play(mp3)
        if (s.listenAfterMs > 0) listenAndSend(s.context, s.listenAfterMs)
    }

    private suspend fun listenAndSend(ctx: String, maxMs: Long) {
        _listening.value = true
        try {
            val file = record(maxMs) ?: return
            try {
                val text = eleven.transcribe(file)
                if (text.isNotBlank()) send(PhoneFrame.Utterance(text, ctx))
            } finally { file.delete() }
        } catch (e: Exception) {
            Log.w(TAG, "listen failed", e)
        } finally { _listening.value = false }
    }

    private suspend fun play(mp3: ByteArray) = withContext(Dispatchers.Main) {
        val f = File.createTempFile("speak", ".mp3", context.cacheDir).apply { writeBytes(mp3) }
        try {
            suspendCancellableCoroutine { cont ->
                val mp = MediaPlayer()
                cont.invokeOnCancellation { runCatching { mp.release() } }
                try {
                    mp.setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    mp.setDataSource(f.path)
                    mp.setOnCompletionListener { it.release(); if (cont.isActive) cont.resume(Unit) }
                    mp.setOnErrorListener { p, _, _ -> p.release(); if (cont.isActive) cont.resume(Unit); true }
                    mp.setOnPreparedListener { it.start() }
                    mp.prepareAsync()
                } catch (e: Exception) { mp.release(); if (cont.isActive) cont.resume(Unit) }
            }
        } finally { f.delete() }
    }

    /** Records up to [maxMs]; stops early after speech followed by [SILENCE_MS] of quiet. Null if nothing was said. */
    private suspend fun record(maxMs: Long): File? = withContext(Dispatchers.IO) {
        val out = File.createTempFile("utt", ".m4a", context.cacheDir)
        @Suppress("DEPRECATION")
        val rec = MediaRecorder().apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(16_000)
            setOutputFile(out.path)
            prepare(); start()
        }
        var spoke = false
        var quietMs = 0L
        var t = 0L
        try {
            while (t < maxMs) {
                delay(POLL_MS); t += POLL_MS
                val loud = rec.maxAmplitude > SPEECH_AMPLITUDE
                if (loud) { spoke = true; quietMs = 0 } else if (spoke) quietMs += POLL_MS
                if (spoke && quietMs >= SILENCE_MS) break
            }
        } finally {
            runCatching { rec.stop() }; rec.release()
        }
        if (spoke) out else { out.delete(); null }
    }

    companion object {
        const val TAG = "VoiceLoop"
        const val POLL_MS = 100L
        const val SILENCE_MS = 1_200L
        const val SPEECH_AMPLITUDE = 2_500
    }
}
