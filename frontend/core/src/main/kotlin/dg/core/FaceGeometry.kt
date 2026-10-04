package dg.core

import kotlin.math.hypot

/** One face landmark in image pixels. */
data class Pt(val x: Double, val y: Double)

/**
 * Eye and mouth openness from SmartSpectra's dense face landmarks. Presage has no
 * eye-closure ratio or yawn output, but its 478-point mesh matches the MediaPipe
 * Face Mesh layout (468 face + 10 iris), so the classic ratios work on it.
 * Ported from ../android (FaceGeometry.kt).
 */
object FaceGeometry {
    const val FULL_MESH_SIZE = 468

    /**
     * Eye aspect ratio at or above this counts as fully open, at or below [EAR_CLOSED] as closed.
     * Tuned on a Galaxy S24 held below the face: open eyes read 0.23-0.28, closed 0.04-0.11.
     */
    const val EAR_OPEN = 0.22
    const val EAR_CLOSED = 0.10

    /** Mouth openness above this is a yawn candidate. */
    const val MAR_YAWN = 0.6

    // Eye aspect ratio points: outer corner, two upper lid, inner corner, two lower lid.
    private val RIGHT_EYE = intArrayOf(33, 160, 158, 133, 153, 144)
    private val LEFT_EYE = intArrayOf(362, 385, 387, 263, 373, 380)

    // Inner lips (top, bottom) and mouth corners.
    private const val LIP_TOP = 13
    private const val LIP_BOTTOM = 14
    private const val MOUTH_LEFT = 78
    private const val MOUTH_RIGHT = 308

    /** Eye aspect ratio averaged over both eyes, about 0.25 open and near 0.1 closed. Null if the mesh is incomplete. */
    fun eyeOpenness(points: List<Pt>): Double? {
        if (points.size < FULL_MESH_SIZE) return null
        return (eyeAspectRatio(points, RIGHT_EYE) + eyeAspectRatio(points, LEFT_EYE)) / 2
    }

    /** Mouth opening relative to mouth width: near 0 closed, above about 0.6 for a yawn. Null if the mesh is incomplete. */
    fun mouthOpenness(points: List<Pt>): Double? {
        if (points.size < FULL_MESH_SIZE) return null
        val width = dist(points[MOUTH_LEFT], points[MOUTH_RIGHT])
        if (width <= 0.0) return null
        return dist(points[LIP_TOP], points[LIP_BOTTOM]) / width
    }

    /** Maps an eye aspect ratio to closure 0 (open) .. 1 (closed). */
    fun eyeClosure(ear: Double): Double =
        ((EAR_OPEN - ear) / (EAR_OPEN - EAR_CLOSED)).coerceIn(0.0, 1.0)

    private fun eyeAspectRatio(points: List<Pt>, eye: IntArray): Double {
        val p = eye.map { points[it] }
        val width = dist(p[0], p[3])
        if (width <= 0.0) return 0.0
        return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * width)
    }

    private fun dist(a: Pt, b: Pt): Double = hypot(a.x - b.x, a.y - b.y)
}

/** Summary of the landmark samples received since the last [FaceSampler.drain]. */
data class FaceSummary(
    val samples: Int,
    val eyeClosed: Double?, // mean eye closure 0..1 across the samples
    val mouthOpenMax: Double?, // peak mouth openness, for tuning MAR_YAWN
    val yawned: Boolean,
    val earMean: Double? = null, // raw eye aspect ratio, for tuning EAR_OPEN / EAR_CLOSED
    val earMin: Double? = null,
)

/**
 * Consumes every SmartSpectra landmark sample. Each metrics update carries a batch of samples
 * (one per camera frame), so reading only the latest one per second would miss most of a yawn.
 * Samples already seen (same or older timestamp) are skipped. The timestamp unit is inferred
 * from the spacing between frames: MediaPipe uses microseconds, but ms and ns are handled too.
 */
class FaceSampler(private val yawns: YawnDetector = YawnDetector()) {
    private var lastTs = Long.MIN_VALUE
    /** Timestamp units per millisecond, once known (1 = ms, 1000 = µs, 1_000_000 = ns). */
    var unitsPerMs: Long? = null; private set
    var totalYawns = 0; private set

    private var n = 0
    private var closureSum = 0.0
    private var closureN = 0
    private var mouthMax: Double? = null
    private var earSum = 0.0
    private var earMin: Double? = null
    private var yawned = false

    /** Feed one sample. Returns false if it was a duplicate. */
    fun add(ts: Long, points: List<Pt>): Boolean {
        if (ts <= lastTs) return false
        if (unitsPerMs == null && lastTs != Long.MIN_VALUE) unitsPerMs = unitFromFrameGap(ts - lastTs)
        lastTs = ts
        n++
        val ear = FaceGeometry.eyeOpenness(points)
        val mar = FaceGeometry.mouthOpenness(points)
        if (ear != null) { closureSum += FaceGeometry.eyeClosure(ear); closureN++; earSum += ear; earMin = minOf(earMin ?: ear, ear) }
        if (mar != null) mouthMax = maxOf(mouthMax ?: mar, mar)
        if (yawns.update(ts / (unitsPerMs ?: 1000L), mar)) { yawned = true; totalYawns++ }
        return true
    }

    fun drain(): FaceSummary {
        val s = FaceSummary(n, if (closureN > 0) closureSum / closureN else null, mouthMax, yawned, if (closureN > 0) earSum / closureN else null, earMin)
        n = 0; closureSum = 0.0; closureN = 0; mouthMax = null; yawned = false; earSum = 0.0; earMin = null
        return s
    }

    /** Camera frames are 15-60 ms apart; pick the unit that makes the gap land there. */
    private fun unitFromFrameGap(gap: Long): Long = when {
        gap >= 5_000_000 -> 1_000_000 // ns
        gap >= 5_000 -> 1_000 // µs
        else -> 1 // ms
    }
}

/**
 * Turns per-frame mouth openness into discrete yawns: the mouth must stay wide open for
 * [minOpenMs] (a yawn holds for seconds; speech opens the mouth only briefly), and two yawns
 * are at least [refractoryMs] apart. Dips shorter than [gapToleranceMs] (one jittery frame,
 * a dropped landmark sample) don't break an ongoing yawn. Feed it every landmark sample.
 */
class YawnDetector(
    private val threshold: Double = FaceGeometry.MAR_YAWN,
    private val minOpenMs: Long = 1_500,
    private val refractoryMs: Long = 5_000,
    private val gapToleranceMs: Long = 150, // ~4 frames at 30 fps; shorter than the closures between syllables
) {
    private var openSince: Long? = null
    private var lastOpenMs: Long? = null
    private var lastYawnMs: Long? = null

    /** Feed one sample; returns true on the sample where a yawn is recognized. */
    fun update(nowMs: Long, mouthOpenness: Double?): Boolean {
        if (mouthOpenness == null || mouthOpenness < threshold) {
            val lastOpen = lastOpenMs
            if (lastOpen == null || nowMs - lastOpen > gapToleranceMs) openSince = null
            return false
        }
        lastOpenMs = nowMs
        val since = openSince ?: nowMs.also { openSince = it }
        val last = lastYawnMs
        if (nowMs - since >= minOpenMs && (last == null || nowMs - last >= refractoryMs)) {
            lastYawnMs = nowMs
            openSince = null
            return true
        }
        return false
    }
}
