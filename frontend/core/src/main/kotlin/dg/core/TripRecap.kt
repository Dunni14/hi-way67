package dg.core

import kotlin.math.roundToInt

/** What the end-of-trip popup shows. Null values were not measured on this trip. */
data class TripRecap(
    val durationMin: Int,
    val avgSpeedMph: Double?,
    val topSpeedMph: Double?,
    val alertness: Int?, // 0..100, higher is more alert; null when the engine scored nothing
) {
    /** The design's three states for the alertness value. */
    val alertnessLabel: String?
        get() = alertness?.let { when { it >= 85 -> "GREAT"; it >= 70 -> "GOOD"; else -> "LOW" } }

    companion object {
        /** Alertness is the inverse of the trip's average risk score. */
        fun alertnessOf(avgRisk: Double): Int = (100 - avgRisk).roundToInt().coerceIn(0, 100)

        fun of(durationMs: Long, speed: SpeedTracker, card: ReportCard?) = TripRecap(
            durationMin = ((durationMs + 59_999) / 60_000).toInt(),
            avgSpeedMph = speed.avg,
            topSpeedMph = speed.top,
            alertness = card?.let { alertnessOf(it.avgRisk) },
        )
    }
}

/** Running average and maximum of the speed readings taken during a trip. */
class SpeedTracker {
    private var sum = 0.0
    private var n = 0
    var top: Double? = null; private set
    val avg: Double? get() = if (n > 0) sum / n else null

    fun add(mph: Double) {
        if (mph.isNaN() || mph < 0) return
        sum += mph; n++
        top = maxOf(top ?: mph, mph)
    }
}
