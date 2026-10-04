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
