package com.example.coolvitals

/**
 * Rolling statistics over SmartSpectra's per-frame blink detections.
 * Timestamps are the app's own clock (ms) at the time a sample arrived.
 */
class FaceStats(private val windowMs: Long = 60_000) {

    private val blinkSamples = ArrayDeque<Pair<Long, Boolean>>()
    private val blinkStarts = ArrayDeque<Long>()
    private var lastBlinking = false

    fun addBlinking(detected: Boolean, now: Long) {
        if (detected && !lastBlinking) blinkStarts.addLast(now)
        lastBlinking = detected
        blinkSamples.addLast(now to detected)
        trim(now)
    }

    /** Share of recent samples where a blink (eyes closed) was detected, 0..1. */
    val eyesClosedFraction: Float
        get() = if (blinkSamples.isEmpty()) 0f
        else blinkSamples.count { it.second }.toFloat() / blinkSamples.size

    /** Blinks counted in the window, scaled to a per-minute rate. */
    val blinksPerMinute: Int
        get() = (blinkStarts.size * 60_000L / windowMs).toInt()

    fun reset() {
        blinkSamples.clear()
        blinkStarts.clear()
        lastBlinking = false
    }

    private fun trim(now: Long) {
        val cutoff = now - windowMs
        while (blinkSamples.isNotEmpty() && blinkSamples.first().first < cutoff) blinkSamples.removeFirst()
        while (blinkStarts.isNotEmpty() && blinkStarts.first() < cutoff) blinkStarts.removeFirst()
    }
}
