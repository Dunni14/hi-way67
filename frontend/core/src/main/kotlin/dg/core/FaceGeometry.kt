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

    /** Eye aspect ratio at or above this counts as fully open, at or below [EAR_CLOSED] as closed. */
    const val EAR_OPEN = 0.28
    const val EAR_CLOSED = 0.18

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

    /** Eye aspect ratio averaged over both eyes, about 0.3 open and under 0.2 closed. Null if the mesh is incomplete. */
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

/**
 * Turns per-frame mouth openness into discrete yawns: the mouth must stay wide
 * open for [minOpenMs], and two yawns are at least [refractoryMs] apart.
 */
class YawnDetector(
    private val threshold: Double = FaceGeometry.MAR_YAWN,
    private val minOpenMs: Long = 1_500,
    private val refractoryMs: Long = 5_000,
) {
    private var openSince: Long? = null
    private var lastYawnMs: Long? = null

    /** Feed one sample; returns true on the sample where a yawn is recognized. */
    fun update(nowMs: Long, mouthOpenness: Double?): Boolean {
        if (mouthOpenness == null || mouthOpenness < threshold) { openSince = null; return false }
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
