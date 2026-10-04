package dev.driverguardian.alarm

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import dev.driverguardian.R

/** The one bundled alarm sound for the alarm stage (tier 85). Placeholder tone in res/raw/alarm.wav. */
class AlarmPlayer(private val context: Context) {
    private var player: MediaPlayer? = null
    val isPlaying get() = player?.isPlaying == true

    fun play() {
        stop()
        player = MediaPlayer.create(
            context, R.raw.alarm,
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
