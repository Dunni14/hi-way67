package dg.core

data class ReportPoint(val ts: Long, val R: Double, val lat: Double? = null, val lon: Double? = null)

data class TripReport(
    val points: List<ReportPoint>,
    val durationSec: Long,
    val avgR: Double,
    val peakR: Double,
    val highRiskShare: Double, // share of scored windows at R >= 70
    val hardBrakes: Int,
    val swerves: Int,
    val yawns: Int,
    val nods: Int,
    val maxTier: Int,
    val grade: String,
    val advice: String,
)

/** Collects scored windows during a trip and builds the end-of-trip report card. */
class ReportBuilder {
    private val points = mutableListOf<ReportPoint>()
    private var startMs = 0L
    private var endMs = 0L
    private var brakes = 0
    private var swerves = 0
    private var yawns = 0
    private var nods = 0
    private var maxTier = 0

    fun start(now: Long) {
        points.clear(); startMs = now; endMs = now
        brakes = 0; swerves = 0; yawns = 0; nods = 0; maxTier = 0
    }

    /** Calibration windows carry no risk and are not recorded. */
    fun add(w: PhoneFrame.RiskWindow, calibrating: Boolean, tier: Int?) {
        endMs = w.ts
        if (calibrating) return
        points += ReportPoint(w.ts, w.risk, w.lat, w.lon)
        for (e in w.events) when (e) {
            DriverEvent.HARD_BRAKE -> brakes++
            DriverEvent.SWERVE -> swerves++
            DriverEvent.YAWN -> yawns++
            DriverEvent.NOD -> nods++
        }
        if (tier != null && tier > maxTier) maxTier = tier
    }

    fun build(now: Long = endMs): TripReport {
        val rs = points.map { it.R }
        val avg = if (rs.isEmpty()) 0.0 else rs.average()
        val peak = rs.maxOrNull() ?: 0.0
        val high = if (rs.isEmpty()) 0.0 else rs.count { it >= 70 } / rs.size.toDouble()
        val grade = gradeOf(avg, high, maxTier)
        return TripReport(
            points.toList(), (now - startMs) / 1000, avg, peak, high,
            brakes, swerves, yawns, nods, maxTier, grade,
            adviceFor(grade, brakes + swerves, yawns + nods, maxTier),
        )
    }

    companion object {
        fun gradeOf(avgR: Double, highShare: Double, maxTier: Int): String {
            val score = avgR + 40 * highShare + if (maxTier >= 85) 15 else 0
            return when {
                score < 15 -> "A"
                score < 30 -> "B"
                score < 45 -> "C"
                score < 60 -> "D"
                else -> "F"
            }
        }

        fun adviceFor(grade: String, motionEvents: Int, fatigueEvents: Int, maxTier: Int): String = when {
            maxTier >= 85 -> "Risk got critical on this trip; pull over and rest before the next drive."
            fatigueEvents >= 3 && fatigueEvents >= motionEvents -> "Frequent yawning and nodding: take a break every two hours and avoid driving this late."
            motionEvents >= 3 -> "Several hard brakes or swerves: leave more following distance and ease off the speed."
            grade == "A" -> "Smooth and alert drive. Keep it up."
            else -> "Mostly steady driving; watch for early signs of tiredness on longer trips."
        }
    }
}
