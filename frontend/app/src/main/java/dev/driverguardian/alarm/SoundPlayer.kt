package dev.driverguardian.alarm

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
import dev.driverguardian.R

/**
 * Wake-up sound the group chat voted for (`play_sound`): plays res/raw/<id> (rooster, airhorn, goat).
 * Falls back to the alarm tone if that file isn't bundled yet. Plays once; nothing is sent back.
 */
class SoundPlayer(private val context: Context) {
    private var player: MediaPlayer? = null

    fun play(id: String) {
        stop()
        @Suppress("DiscouragedApi") // the id comes from the backend, so the resource is looked up by name
        val res = context.resources.getIdentifier(id, "raw", context.packageName).takeIf { it != 0 }
            ?: R.raw.alarm.also { Log.w("SoundPlayer", "res/raw/$id missing, playing the alarm instead") }
        player = MediaPlayer.create(
            context, res,
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
            android.media.AudioManager.AUDIO_SESSION_ID_GENERATE,
        )?.apply {
            setOnCompletionListener { it.release(); if (player === it) player = null }
            start()
        }
    }

    fun stop() {
        player?.let { runCatching { if (it.isPlaying) it.stop() }; it.release() }
        player = null
    }
}
