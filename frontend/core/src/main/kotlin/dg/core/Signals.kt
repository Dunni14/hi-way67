package dg.core

/** Fixed demo speed limit (no live speed-limit lookup). */
const val SPEED_LIMIT_MPH = 65.0

/** One ~1 Hz Presage sample. Nullable signals are missing. */
data class PresageFrame(
    val tsMs: Long,
    val confidence: Double = 1.0,
    val eyeClosed: Double? = null, // 0..1 closure this frame
    val longBlink: Boolean = false,
    val yawn: Boolean = false,
    val nod: Boolean = false,
    val heartRate: Double? = null,
    val breathing: Double? = null,
    val stress: Double? = null, // stress / anger probability
    val gazeOffRoad: Boolean = false,
    // Shown live on the dashcam and debug views.
    val talking: Boolean? = null, // Presage talking detection
    val mouthOpen: Double? = null, // peak mouth openness this second (FaceGeometry), for tuning the yawn threshold
    val closedRunMs: Long? = null, // longest continuous eye closure seen this second (counts runs still going)
)

/**
 * Collects one 10 s window of sensing into the raw signals the backend's risk engine scores
 * (WindowSignals mirrors its SignalWindow). No scoring happens on the phone: the engine owns the
 * baseline, levels, tiers and every alert.
 */
class WindowAggregator {
    private var frames = 0
    private var faceFrames = 0
    private var eyeSum = 0.0; private var eyeN = 0
    private var hrSum = 0.0; private var hrN = 0
    private var brSum = 0.0; private var brN = 0
    private var stressSum = 0.0; private var stressN = 0
    private var longestClosedMs = 0L
    private var yawns = 0
    private var nod = false
    private var brakes = 0
    private var swerves = 0

    private var speedMph = 0.0
    private var lat: Double? = null
    private var lon: Double? = null

    fun onMotion(mph: Double, lat: Double?, lon: Double?) { speedMph = mph; this.lat = lat; this.lon = lon }

    fun onImuEvent(event: String) {
        when (event) {
            DriverEvent.HARD_BRAKE -> brakes++
            DriverEvent.SWERVE -> swerves++
        }
    }

    fun onPresage(f: PresageFrame) {
        frames++
        if (f.confidence < MIN_CONFIDENCE) return // no usable face this frame: its signals stay missing
        faceFrames++
        f.eyeClosed?.let { eyeSum += it; eyeN++ }
        f.heartRate?.let { hrSum += it; hrN++ }
        f.breathing?.let { brSum += it; brN++ }
        f.stress?.let { stressSum += it; stressN++ }
        f.closedRunMs?.let { longestClosedMs = maxOf(longestClosedMs, it) }
        if (f.yawn) yawns++
        if (f.nod) nod = true
    }

    /** Close the window ending at [tsMs] (real time) and reset for the next one. */
    fun close(tsMs: Long): PhoneFrame.RiskWindow {
        val face = faceFrames > 0
        val signals = WindowSignals(
            faceVisible = if (frames == 0) null else face,
            heartRate = mean(hrSum, hrN),
            breathingRate = mean(brSum, brN),
            eyeClosureFrac = mean(eyeSum, eyeN),
            longestEyeClosureS = if (face) longestClosedMs / 1000.0 else null,
            yawns = if (face) yawns else null,
            emotionStress = mean(stressSum, stressN),
            hardBrakes = brakes,
            swerves = swerves,
            speedMph = speedMph,
            speedLimitMph = SPEED_LIMIT_MPH,
        )
        val events = buildList {
            repeat(yawns) { add(DriverEvent.YAWN) }
            if (nod) add(DriverEvent.NOD)
            if (brakes > 0) add(DriverEvent.HARD_BRAKE)
            if (swerves > 0) add(DriverEvent.SWERVE)
        }
        val window = PhoneFrame.RiskWindow(ts = tsMs, speed = speedMph, lat = lat, lon = lon, events = events, signals = signals)
        frames = 0; faceFrames = 0
        eyeSum = 0.0; eyeN = 0; hrSum = 0.0; hrN = 0; brSum = 0.0; brN = 0; stressSum = 0.0; stressN = 0
        longestClosedMs = 0; yawns = 0; nod = false; brakes = 0; swerves = 0
        return window
    }

    private fun mean(sum: Double, n: Int) = if (n > 0) sum / n else null

    companion object { const val MIN_CONFIDENCE = 0.5 }
}
