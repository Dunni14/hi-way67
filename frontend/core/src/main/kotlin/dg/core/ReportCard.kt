package dg.core

/** One point on the report card's risk line. */
data class ReportPoint(val ts: Long, val risk: Double)

/** One scored window: what the phone sent plus the engine's verdict. */
data class TripSample(val ts: Long, val score: Double, val tier: Int, val dominant: Dominant, val alerted: Boolean, val events: List<String>)

data class ReportCard(
    val grade: String,
    val advice: String,
    val durationMin: Int,
    val avgRisk: Double,
    val peakRisk: Double,
    val pctHighRisk: Double, // share of windows at tier 2 or 3, 0..100
    val alertsByTier: Map<Int, Int>, // engine tier (1..3) -> spoken alerts
    val eventCounts: Map<String, Int>,
    val series: List<ReportPoint>,
) {
    companion object {
        /** Computed on the phone from the engine's evaluations of this trip. Null when there is nothing to grade. */
        fun build(samples: List<TripSample>): ReportCard? {
            if (samples.isEmpty()) return null
            val scores = samples.map { it.score }
            val avg = scores.average()
            val peak = scores.max()
            val high = samples.count { it.tier >= 2 } * 100.0 / samples.size
            val byTier = (1..3).associateWith { t -> samples.count { it.alerted && it.tier == t } }.filterValues { it > 0 }
            val events = samples.flatMap { it.events }.groupingBy { it }.eachCount()
            val grade = grade(avg, high, byTier[3] ?: 0)
            val dominantDrowsy = samples.count { it.dominant == Dominant.DROWSY } * 2 >= samples.size
            val durationMs = samples.last().ts - samples.first().ts
            return ReportCard(
                grade = grade,
                advice = advice(grade, dominantDrowsy, events),
                durationMin = ((durationMs + 59_999) / 60_000).toInt(),
                avgRisk = avg, peakRisk = peak, pctHighRisk = high,
                alertsByTier = byTier, eventCounts = events,
                series = samples.map { ReportPoint(it.ts, it.score) },
            )
        }

        fun grade(avg: Double, pctHigh: Double, tier3Alerts: Int): String {
            var score = when {
                avg < 15 -> 0
                avg < 30 -> 1
                avg < 45 -> 2
                avg < 60 -> 3
                else -> 4
            }
            if (pctHigh >= 10) score++
            if (tier3Alerts > 0) score++
            return when (score) { 0 -> "A"; 1 -> "B"; 2 -> "C"; 3 -> "D"; else -> "F" }
        }

        private fun advice(grade: String, drowsy: Boolean, events: Map<String, Int>): String = when {
            grade == "A" || grade == "B" -> "Steady, alert drive. Nothing to change."
            drowsy && (events[DriverEvent.YAWN] ?: 0) + (events[DriverEvent.NOD] ?: 0) > 0 ->
                "Yawning and nodding showed up. Pull over for a break or a nap before the next long stretch."
            drowsy -> "You looked tired for much of this trip. Plan a rest stop every two hours."
            (events[DriverEvent.HARD_BRAKE] ?: 0) + (events[DriverEvent.SWERVE] ?: 0) > 0 ->
                "Hard braking and swerves stood out. Leave more following distance and ease off earlier."
            else -> "Your stress and speed ran high. Slow down and give yourself more time."
        }
    }
}
