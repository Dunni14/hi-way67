package dg.core

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

fun clamp01(v: Double) = max(0.0, min(1.0, v))

val FEATURES = listOf(
    "eye_closure", "long_blinks", "yawns", "head_nod", "breathing_dev", "heart_rate_dev",
    "emotion_stress", "hard_brake_count", "swerve_count", "speed_over_limit",
    "sleep_deficit", "hours_driving", "night_time",
)

/** Feature vector; a null entry is a missing signal (low confidence), not zero. */
typealias Features = Map<String, Double?>

/** Weights live in process memory only and reset on app start. */
class WeightStore {
    data class Nudge(val dominant: Dominant, val before: Map<String, Double>, val after: Map<String, Double>)

    val drowsy: MutableMap<String, Double> = defaultDrowsy().toMutableMap()
    val reckless: MutableMap<String, Double> = defaultReckless().toMutableMap()
    var lastNudge: Nudge? = null
        private set

    fun of(d: Dominant) = if (d == Dominant.DROWSY) drowsy else reckless

    /** w <- max(0, w - eta * x) on the dominant sub-score's weights. */
    fun nudge(dominant: Dominant, x: Map<String, Double>, eta: Double = ETA): Nudge {
        val w = of(dominant)
        val before = w.toMap()
        for ((k, v) in x) if (k in w) w[k] = max(0.0, w.getValue(k) - eta * v)
        return Nudge(dominant, before, w.toMap()).also { lastNudge = it }
    }

    companion object {
        const val ETA = 0.02
        fun defaultDrowsy() = mapOf(
            "eye_closure" to 0.32, "long_blinks" to 0.12, "yawns" to 0.20, "head_nod" to 0.16,
            "breathing_dev" to 0.08, "heart_rate_dev" to 0.0, "emotion_stress" to 0.0,
            "hard_brake_count" to 0.0, "swerve_count" to 0.0, "speed_over_limit" to 0.0,
            "sleep_deficit" to 0.0, "hours_driving" to 0.06, "night_time" to 0.06,
        )
        fun defaultReckless() = mapOf(
            "eye_closure" to 0.0, "long_blinks" to 0.0, "yawns" to 0.0, "head_nod" to 0.0,
            "breathing_dev" to 0.0, "heart_rate_dev" to 0.25, "emotion_stress" to 0.25,
            "hard_brake_count" to 0.22, "swerve_count" to 0.22, "speed_over_limit" to 0.16,
            "sleep_deficit" to 0.0, "hours_driving" to 0.0, "night_time" to 0.0,
        )
    }
}

data class RiskResult(
    val rRaw: Double, val drowsy: Double, val reckless: Double,
    val R: Double, val m: Double, val dominant: Dominant,
    val rDrowsy: Double, val rReckless: Double,
)

class RiskModel(val weights: WeightStore = WeightStore()) {
    /** Latest window's x (missing treated as 0 for the nudge) and dominant sub-score. */
    var latestX: Map<String, Double> = emptyMap(); private set
    var latestDominant: Dominant = Dominant.DROWSY; private set

    fun score(x: Features, speedMph: Double, kidsInCar: Boolean, lowExperience: Boolean = false): RiskResult {
        val rd = dot(weights.drowsy, x)
        val rr = dot(weights.reckless, x)
        val m = multiplier(speedMph, kidsInCar, lowExperience)
        val dominant = if (rd >= rr) Dominant.DROWSY else Dominant.RECKLESS
        latestX = x.mapValues { it.value ?: 0.0 }
        latestDominant = dominant
        fun scale(r: Double) = max(0.0, min(100.0, 100 * r * m))
        return RiskResult(max(rd, rr), scale(rd), scale(rr), scale(max(rd, rr)), m, dominant, rd, rr)
    }

    /** Dot product over present features only, with the remaining weights renormalized to the full total. */
    private fun dot(w: Map<String, Double>, x: Features): Double {
        val total = w.values.sum()
        var present = 0.0
        var sum = 0.0
        for ((k, wk) in w) {
            val v = x[k] ?: continue
            present += wk
            sum += wk * v
        }
        if (present <= 1e-9) return 0.0
        val scale = min(total / present, MAX_RENORM)
        return clamp01(sum * scale)
    }

    companion object {
        const val KIDS_C = 0.25 // context vector c = (kids_in_car, low_experience); medication stays fixed at 0
        const val LOW_EXP_C = 0.15
        const val SPEED_B = 1.0
        const val MAX_RENORM = 2.0

        /** Context-only multiplier, shown on the trip-start screen. */
        fun contextMultiplier(kidsInCar: Boolean, lowExperience: Boolean): Double =
            1 + KIDS_C * (if (kidsInCar) 1.0 else 0.0) + LOW_EXP_C * (if (lowExperience) 1.0 else 0.0)

        fun multiplier(speedMph: Double, kidsInCar: Boolean, lowExperience: Boolean = false): Double {
            val v = min(speedMph / 70.0, 1.5)
            return contextMultiplier(kidsInCar, lowExperience) * (1 + SPEED_B * v)
        }
    }
}

object Normalize {
    const val SPEED_LIMIT_MPH = 65.0 // fixed demo constant

    fun speedOverLimit(mph: Double) = clamp01((mph - SPEED_LIMIT_MPH) / 20.0)
    fun hoursDriving(hours: Double) = min(hours / 4.0, 1.0)

    /** 1 between 22:00 and 05:00, ramped over the hour on each edge. */
    fun nightTime(hourOfDay: Double): Double = when {
        hourOfDay >= 23 || hourOfDay < 4 -> 1.0
        hourOfDay >= 22 -> hourOfDay - 22
        hourOfDay < 5 -> 5 - hourOfDay
        else -> 0.0
    }
    fun absDev(v: Double, base: Double, scale: Double) = clamp01(abs(v - base) / scale)
}
