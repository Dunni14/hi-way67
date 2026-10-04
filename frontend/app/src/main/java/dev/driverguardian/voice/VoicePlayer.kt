package dev.driverguardian.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import dg.core.BackendFrame
import dg.core.PhoneFrame
import dg.core.SpeakContext
import java.io.File

/**
 * Says `speak` frames to the driver and listens for the reply.
 *
 * 1. Plays the ElevenLabs mp3 in `audio`, or speaks `text` with on-device TTS when it is empty.
 * 2. If `listenAfterMs > 0` and the mic is allowed, runs the speech recognizer and sends an
 *    `utterance` with the same `context`.
 * 3. Always ends with `speak_done`, which tells the backend to send the next line.
 *
 * The backend sends one line at a time, so this handles one item; a new line replaces an old one.
 * Everything runs on the main thread (MediaPlayer callbacks and SpeechRecognizer need a looper).
 */
class VoicePlayer(private val context: Context, private val send: (PhoneFrame) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var item: Item? = null

    private var ttsReady = false
    private val tts = TextToSpeech(context) { status -> ttsReady = status == TextToSpeech.SUCCESS }

    private class Item(val frame: BackendFrame.Speak) {
        var player: MediaPlayer? = null
        var file: File? = null
        var recognizer: SpeechRecognizer? = null
        var usedTts = false
        var finished = false
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { main.post { spoken(utteranceId) } }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { main.post { spoken(utteranceId) } }
        })
    }

    fun play(frame: BackendFrame.Speak) {
        main.post {
            item?.let { finish(it) } // a new line supersedes anything still playing
            val it = Item(frame).also { item = it }
            Log.d(TAG, "speak (${frame.context}, tier ${frame.tier}): ${frame.text}")
            if (frame.audio.isEmpty() || !playMp3(it)) speakTts(it)
        }
    }

    fun release() {
        main.post {
            item?.let { finish(it) }
            tts.shutdown()
        }
    }

    private fun playMp3(it: Item): Boolean = try {
        val file = File.createTempFile("speak-", ".mp3", context.cacheDir)
        file.writeBytes(Base64.decode(it.frame.audio, Base64.DEFAULT))
        it.file = file
        it.player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
            )
            setDataSource(file.path)
            setOnPreparedListener { p -> p.start() }
            setOnCompletionListener { _ -> if (item === it) listenThenFinish(it) }
            setOnErrorListener { _, what, extra ->
                Log.w(TAG, "mp3 playback failed ($what/$extra), using on-device TTS")
                if (item === it) speakTts(it)
                true
            }
            prepareAsync()
        }
        true
    } catch (e: Exception) {
        Log.w(TAG, "can't play mp3: ${e.message}")
        false
    }

    private fun speakTts(it: Item) {
        it.player?.release(); it.player = null
        if (!ttsReady) { Log.w(TAG, "TTS not ready, skipping: ${it.frame.text}"); listenThenFinish(it); return }
        it.usedTts = true
        tts.speak(it.frame.text, TextToSpeech.QUEUE_FLUSH, null, it.frame.id)
    }

    private fun spoken(utteranceId: String?) {
        val it = item ?: return
        if (it.frame.id == utteranceId) listenThenFinish(it)
    }

    private fun listenThenFinish(it: Item) {
        val ms = it.frame.listenAfterMs
        val micOk = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (ms <= 0 || !micOk || !SpeechRecognizer.isRecognitionAvailable(context)) {
            if (ms > 0) Log.w(TAG, "not listening: mic permission=$micOk, recognizer=${SpeechRecognizer.isRecognitionAvailable(context)}")
            finish(it); return
        }
        val rec = SpeechRecognizer.createSpeechRecognizer(context)
        it.recognizer = rec
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank() && item === it && !it.finished) {
                    Log.d(TAG, "heard: $text")
                    send(PhoneFrame.Utterance(text, utteranceContext(it.frame.context)))
                }
                finish(it)
            }
            override fun onError(error: Int) { Log.d(TAG, "recognizer error $error"); finish(it) }
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        rec.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        })
        // Close the window: stop (delivers a final result if speech started), then give up.
        main.postDelayed({ if (!it.finished) rec.stopListening() }, ms)
        main.postDelayed({ finish(it) }, ms + RESULT_GRACE_MS)
    }

    private fun finish(it: Item) {
        if (it.finished) return
        it.finished = true
        if (it.usedTts) tts.stop()
        it.recognizer?.destroy(); it.recognizer = null
        it.player?.let { p -> runCatching { if (p.isPlaying) p.stop() }; p.release() }; it.player = null
        it.file?.delete(); it.file = null
        if (item === it) item = null
        send(PhoneFrame.SpeakDone(it.frame.id))
    }

    /** `utterance.context` only accepts the contexts that listen, or "free". */
    private fun utteranceContext(c: String) = when (c) {
        SpeakContext.CHECKIN, SpeakContext.AFTER_MESSAGE, SpeakContext.PERMISSION, SpeakContext.ROAST -> c
        else -> SpeakContext.FREE
    }

    private companion object {
        const val TAG = "Voice"
        const val RESULT_GRACE_MS = 3_000L
    }
}
