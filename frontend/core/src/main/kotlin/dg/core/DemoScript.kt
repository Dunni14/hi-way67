package dg.core

import kotlin.math.sin

/**
 * Scripted Presage replay so the pipeline and the demo run without the SDK or a face.
 * `t` is seconds since trip start (calibration is the first 60 s). Phases:
 *   0-60 s   rested driver (becomes the baseline)
 *   60-100 s still fine, low score
 *   100 s+   drowsiness builds: eyes close more, yawns, nods -> tiers 40, 70, 85
 */
object DemoScript {
    const val DEMO_SPEED_MPH = 65.0

    fun frame(tsMs: Long, tSec: Double): PresageFrame {
        val wobble = sin(tSec * 0.7) * 0.01
        val drift = ((tSec - 100.0) / 600.0).coerceIn(0.0, 1.0) // 0 -> 1 over 100..700 s
        val sec = tSec.toInt()
        return PresageFrame(
            tsMs = tsMs,
            confidence = 0.95,
            eyeClosed = (0.05 + wobble + drift * 0.30).coerceIn(0.0, 1.0),
            longBlink = drift > 0.03 && sec % 6 == 0,
            yawn = drift > 0.05 && sec % 20 == 0,
            nod = drift > 0.25 && sec % 15 == 0,
            heartRate = 72.0 - drift * 8 + wobble * 50,
            breathing = 15.0 - drift * 4,
            stress = 0.05,
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
