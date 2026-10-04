package dg.core

import kotlin.math.sin

/**
 * Scripted Presage replay so the pipeline and the demo run without the SDK or a face. `t` is
 * script seconds since trip start; the backend's risk engine (10 s windows) scores it:
 *   0-60 s    rested driver: the engine's 6 baseline windows
 *   60-130 s  still fine, score about 4
 *   130 s+    drowsy: eyes 40% closed, slow breathing, a yawn per window. The drowsy level climbs
 *             past 0.45 (drowsy_onset: tier 1, a spoken check-in that listens) and then 0.6
 *             (drowsy_sustained_3: tier 2, a firmer check-in).
 *   256 s     a 2.2 s eye closure in window 251-260: the microsleep override asks the driver to
 *             answer. Saying anything stops it there; silence sounds the alarm and texts contacts.
 * With DemoClock that is about 0:15 and 1:08 real time. backend `npm run fake-phone` sends the
 * same profile window by window.
 */
object DemoScript {
    const val DEMO_SPEED_MPH = 65.0
    const val DROWSY_FROM_S = 130.0
    const val MICROSLEEP_AT_S = 256

    fun frame(tsMs: Long, tSec: Double): PresageFrame {
        val wobble = sin(tSec * 0.7) * 0.01
        val sec = tSec.toInt()
        val drowsy = tSec > DROWSY_FROM_S
        return PresageFrame(
            tsMs = tsMs,
            confidence = 0.95,
            eyeClosed = ((if (drowsy) 0.40 else 0.05) + wobble).coerceIn(0.0, 1.0),
            longBlink = drowsy && sec % 6 == 0,
            yawn = drowsy && sec % 10 == 5,
            heartRate = (if (drowsy) 64.0 else 72.0) + wobble * 50,
            breathing = if (drowsy) 10.5 else 15.0,
            stress = 0.05,
            talking = false,
            mouthOpen = if (drowsy && sec % 10 == 5) 0.8 else 0.05,
            closedRunMs = when {
                sec == MICROSLEEP_AT_S -> 2_200
                drowsy -> 600
                else -> 250 // ordinary blink
            },
        )
    }
}

/**
 * Maps real time since trip start to trip-engine time ("script time"). The engine, its gate and the
 * fake Presage source all run on script time; the backend and report card get real timestamps.
 */
interface TripClock {
    fun scriptMs(realElapsedMs: Long): Long
    fun realMs(scriptMs: Long): Long
    /** Script ms per real ms after the opening phase; scales real-time cooldowns into script time. */
    val steadyRate: Double
}

object RealClock : TripClock {
    override fun scriptMs(realElapsedMs: Long) = realElapsedMs
    override fun realMs(scriptMs: Long) = scriptMs
    override val steadyRate = 1.0
}

/**
 * Demo pacing: race through calibration and the quiet start at [FAST_RATE], then slow to
 * [SLOW_RATE] from the first alert on, so the driver has time to answer each spoken check-in.
 * With [DemoScript]'s 40 / 70 / 85 at 180 / 220 / 280 s of script time, that's about
 * 0:15 / 0:42 / 1:22 real time. Use [RealClock] for the original 3:00 / 3:40 / 4:40.
 */
object DemoClock : TripClock {
    const val FAST_RATE = 12.0
    const val FAST_UNTIL_MS = 180_000L // script time of the first alert (tier 40)
    const val SLOW_RATE = 1.5
    private val fastRealMs = (FAST_UNTIL_MS / FAST_RATE).toLong() // 15 s

    override fun scriptMs(realElapsedMs: Long): Long =
        if (realElapsedMs <= fastRealMs) (realElapsedMs * FAST_RATE).toLong()
        else FAST_UNTIL_MS + ((realElapsedMs - fastRealMs) * SLOW_RATE).toLong()

    override fun realMs(scriptMs: Long): Long =
        if (scriptMs <= FAST_UNTIL_MS) (scriptMs / FAST_RATE).toLong()
        else fastRealMs + ((scriptMs - FAST_UNTIL_MS) / SLOW_RATE).toLong()

    override val steadyRate = SLOW_RATE
}
