package dg.core

/** One point on the report card's risk line. */
data class ReportPoint(val ts: Long, val risk: Double)

data class ReportCard(
    val grade: String,
    val advice: String,
    val durationMin: Int,
    val avgRisk: Double,
    val peakRisk: Double,
    val pctHighRisk: Double, // share of windows with R >= 70, 0..100
    val alertsByTier: Map<Int, Int>,
    val eventCounts: Map<String, Int>,
    val series: List<ReportPoint>,
) {
    companion object {
        const val WINDOW_SEC = 10
        const val HIGH_RISK = 70.0

        /** Computed locally from the windows the app held. Null when there is nothing to grade. */
        fun build(windows: List<PhoneFrame.RiskWindow>, alerts: List<Int>): ReportCard? {
            if (windows.isEmpty()) return null
            val risks = windows.map { it.risk }
            val avg = risks.average()
            val peak = risks.max()
            val high = risks.count { it >= HIGH_RISK } * 100.0 / risks.size
            val byTier = listOf(40, 70, 85).associateWith { t -> alerts.count { it == t } }.filterValues { it > 0 }
            val events = windows.flatMap { it.events }.groupingBy { it }.eachCount()
            val grade = grade(avg, high, byTier[85] ?: 0)
            val dominantDrowsy = windows.sumOf { it.drowsy } >= windows.sumOf { it.reckless }
            return ReportCard(
                grade = grade,
                advice = advice(grade, dominantDrowsy, events),
                durationMin = (windows.size * WINDOW_SEC + 59) / 60,
                avgRisk = avg, peakRisk = peak, pctHighRisk = high,
                alertsByTier = byTier, eventCounts = events,
                series = windows.map { ReportPoint(it.ts, it.risk) },
            )
        }

        fun grade(avg: Double, pctHigh: Double, tier85Alerts: Int): String {
            var score = when {
                avg < 15 -> 0
                avg < 30 -> 1
                avg < 45 -> 2
                avg < 60 -> 3
                else -> 4
            }
            if (pctHigh >= 10) score++
            if (tier85Alerts > 0) score++
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
