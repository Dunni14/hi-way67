package dg.core

fun tierOf(R: Double): Int = when {
    R >= 85 -> 85
    R >= 70 -> 70
    R >= 40 -> 40
    else -> 0
}

class Clock(var nowMs: Long = 0)

/**
 * Phone half of the decision tree: 15 s hold, 2 min cooldown per tier, 70 sustained 2 min -> 85,
 * silence during calibration. The kids-in-car bump is the backend's job and is not done here.
 */
class AlertGate(
    private val holdMs: Long = 15_000,
    private val cooldownMs: Long = 120_000,
    private val sustainMs: Long = 120_000,
) {
    private var band = 0
    private var bandSince = 0L
    private val cooldownUntil = mutableMapOf<Int, Long>()

    val currentBand get() = band
    fun bandHeldMs(now: Long) = if (band == 0) 0 else now - bandSince
    fun cooldownRemainingMs(tier: Int, now: Long) = maxOf(0L, (cooldownUntil[tier] ?: 0L) - now)

    /** Returns the tier to fire now, or null. */
    fun update(now: Long, R: Double, calibrating: Boolean): Int? {
        if (calibrating) { band = 0; return null }
        val b = tierOf(R)
        if (b != band) { band = b; bandSince = now }
        if (b == 0) return null
        val held = now - bandSince
        if (held < holdMs) return null
        val effective = if (b == 70 && held >= sustainMs) 85 else b
        if (now < (cooldownUntil[effective] ?: 0L)) return null
        cooldownUntil[effective] = now + cooldownMs
        return effective
    }
}
