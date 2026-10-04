package dg.core

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
    // Shown live on the dashcam and debug views; not part of the risk score.
    val talking: Boolean? = null, // Presage talking detection
    val mouthOpen: Double? = null, // peak mouth openness this second (FaceGeometry), for tuning the yawn threshold
)

/** Rolling average over a time span. */
class SignalSmoother(private val spanMs: Long) {
    private val samples = ArrayDeque<Pair<Long, Double>>()
    fun add(ts: Long, v: Double) { samples.addLast(ts to v); prune(ts) }
    fun prune(now: Long) { while (samples.isNotEmpty() && samples.first().first < now - spanMs) samples.removeFirst() }
    fun mean(now: Long): Double? { prune(now); return if (samples.isEmpty()) null else samples.sumOf { it.second } / samples.size }
}

/** Timestamps of discrete events over a span. */
class EventWindow(private val spanMs: Long) {
    private val ts = ArrayDeque<Long>()
    fun add(t: Long) { ts.addLast(t) }
    fun count(now: Long): Int { while (ts.isNotEmpty() && ts.first() < now - spanMs) ts.removeFirst(); return ts.size }
}

class Baseline {
    var hr: Double? = null; var breathing: Double? = null
    var eyeShare = 0.05; var longBlinksPerMin = 2.0
    private var hrSum = 0.0; private var hrN = 0
    private var brSum = 0.0; private var brN = 0
    private var eyeSum = 0.0; private var eyeN = 0
    private var longBlinks = 0; private var firstTs = -1L; private var lastTs = 0L

    fun add(f: PresageFrame) {
        if (firstTs < 0) firstTs = f.tsMs
        lastTs = f.tsMs
        f.heartRate?.let { hrSum += it; hrN++ }
        f.breathing?.let { brSum += it; brN++ }
        f.eyeClosed?.let { eyeSum += it; eyeN++ }
        if (f.longBlink) longBlinks++
    }

    fun finish() {
        if (hrN > 0) hr = hrSum / hrN
        if (brN > 0) breathing = brSum / brN
        if (eyeN > 0) eyeShare = eyeSum / eyeN
        val mins = (lastTs - firstTs) / 60_000.0
        if (mins > 0.2) longBlinksPerMin = longBlinks / mins
    }
}

/** What happened in one 10 s window. */
data class WindowOutput(
    val window: PhoneFrame.RiskWindow,
    val alertTier: Int?,
    val dominant: Dominant,
    val calibrating: Boolean,
    val cantSeeDriver: Boolean,
    val distracted: Boolean, // debug view only; the protocol has no distracted field
    val result: RiskResult,
    val features: Features,
)

/**
 * Per-trip pipeline: baseline -> smoothing -> feature vector -> risk -> alert gate.
 * Call [closeWindow] every 10 s. All times are epoch ms supplied by the caller.
 */
class TripEngine(
    val model: RiskModel = RiskModel(),
    private val gate: AlertGate = AlertGate(),
    private val calibrationMs: Long = 60_000,
    private val minConfidence: Double = 0.5,
) {
    private var startMs = 0L
    private val baseline = Baseline()
    private var baselineDone = false

    private val eye60 = SignalSmoother(60_000)
    private val hr10 = SignalSmoother(10_000)
    private val br10 = SignalSmoother(10_000)
    private val stress10 = SignalSmoother(10_000)
    private val gaze10 = SignalSmoother(10_000)
    private val longBlinks60 = EventWindow(60_000)
    private val yawns4m = EventWindow(240_000)
    private val nods2m = EventWindow(120_000)

    private var speedMph = 0.0
    private var lat: Double? = null
    private var lon: Double? = null
    private val pendingEvents = mutableListOf<String>()
    private var windowYawn = false; private var windowNod = false
    private var brakes = 0; private var swerves = 0

    val gateState get() = gate

    fun start(nowMs: Long) { startMs = nowMs }

    fun onMotion(mph: Double, lat: Double?, lon: Double?) { speedMph = mph; this.lat = lat; this.lon = lon }

    fun onImuEvent(event: String) {
        when (event) {
            DriverEvent.HARD_BRAKE -> { brakes++; pendingEvents += event }
            DriverEvent.SWERVE -> { swerves++; pendingEvents += event }
        }
    }

    fun onPresage(f: PresageFrame) {
        if (f.confidence < minConfidence) return // low confidence: signals stay missing
        val t = f.tsMs
        val calibrating = t - startMs < calibrationMs
        if (calibrating) baseline.add(f)
        f.eyeClosed?.let { eye60.add(t, it) }
        f.heartRate?.let { hr10.add(t, it) }
        f.breathing?.let { br10.add(t, it) }
        f.stress?.let { stress10.add(t, it) }
        gaze10.add(t, if (f.gazeOffRoad) 1.0 else 0.0)
        if (f.longBlink) longBlinks60.add(t)
        if (f.yawn) { yawns4m.add(t); windowYawn = true }
        if (f.nod) { nods2m.add(t); windowNod = true }
    }

    fun closeWindow(now: Long, kidsInCar: Boolean, hourOfDay: Double): WindowOutput {
        val calibrating = now - startMs < calibrationMs
        if (!calibrating && !baselineDone) { baseline.finish(); baselineDone = true }

        val eyeShare = eye60.mean(now)
        val hr = hr10.mean(now)
        val br = br10.mean(now)
        val stress = stress10.mean(now)
        val cantSee = eyeShare == null

        val x = LinkedHashMap<String, Double?>()
        x["eye_closure"] = eyeShare?.let { clamp01((it - baseline.eyeShare) / 0.25) }
        x["long_blinks"] = if (eyeShare == null) null
            else clamp01((longBlinks60.count(now) - baseline.longBlinksPerMin) / 6.0)
        x["yawns"] = minOf(yawns4m.count(now) / 4.0, 1.0)
        x["head_nod"] = minOf(nods2m.count(now) / 4.0, 1.0)
        x["breathing_dev"] = br?.let { b -> baseline.breathing?.let { clamp01((it - b) / (it * 0.3)) } }
        x["heart_rate_dev"] = hr?.let { h -> baseline.hr?.let { Normalize.absDev(h, it, 25.0) } }
        x["emotion_stress"] = stress?.let { clamp01(it) }
        x["hard_brake_count"] = minOf(brakes / 2.0, 1.0)
        x["swerve_count"] = minOf(swerves / 2.0, 1.0)
        x["speed_over_limit"] = Normalize.speedOverLimit(speedMph)
        x["sleep_deficit"] = 0.0 // pre-trip check excluded
        x["hours_driving"] = Normalize.hoursDriving((now - startMs) / 3_600_000.0)
        x["night_time"] = Normalize.nightTime(hourOfDay)

        val res = if (calibrating) RiskResult(0.0, 0.0, 0.0, 0.0, RiskModel.multiplier(speedMph, kidsInCar), Dominant.DROWSY, 0.0, 0.0)
        else model.score(x, speedMph, kidsInCar)

        val events = buildList {
            if (windowYawn) add(DriverEvent.YAWN)
            if (windowNod) add(DriverEvent.NOD)
            if (brakes > 0) add(DriverEvent.HARD_BRAKE)
            if (swerves > 0) add(DriverEvent.SWERVE)
        }
        val gazeShare = gaze10.mean(now) ?: 0.0
        val distracted = gazeShare > 0.2 // roughly > 2 s of the last 10 s

        val tier = gate.update(now, res.R, calibrating)
        val window = PhoneFrame.RiskWindow(
            ts = now, risk = res.R, drowsy = res.drowsy, reckless = res.reckless,
            speed = speedMph, lat = lat, lon = lon, events = events,
            features = x.mapNotNull { (k, v) -> v?.let { k to it } }.toMap(),
        )
        windowYawn = false; windowNod = false; brakes = 0; swerves = 0; pendingEvents.clear()
        return WindowOutput(window, tier, res.dominant, calibrating, cantSee, distracted, res, x)
    }
}
