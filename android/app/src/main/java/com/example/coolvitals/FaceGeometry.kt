package com.example.coolvitals

import android.graphics.PointF
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Helpers over SmartSpectra's dense face landmarks.
 *
 * Assumes the 478-point MediaPipe Face Mesh layout (468 face points + 10 iris
 * points), which is what SmartSpectra's landmark count matches. If the indices
 * turn out to be different, eye/mouth ratios will look like noise and only the
 * mesh drawing will still make sense.
 */
object FaceGeometry {
    const val FULL_MESH_SIZE = 468

    private const val FOREHEAD = 10
    private const val CHIN = 152

    // Eye aspect ratio points: outer corner, two upper lid, inner corner, two lower lid.
    private val RIGHT_EYE = intArrayOf(33, 160, 158, 133, 153, 144)
    private val LEFT_EYE = intArrayOf(362, 385, 387, 263, 373, 380)

    // Inner lips (top, bottom) and mouth corners.
    private const val LIP_TOP = 13
    private const val LIP_BOTTOM = 14
    private const val MOUTH_LEFT = 78
    private const val MOUTH_RIGHT = 308

    /** Points worth highlighting in the mesh drawing. */
    val FEATURE_POINTS: Set<Int> =
        (RIGHT_EYE + LEFT_EYE + intArrayOf(LIP_TOP, LIP_BOTTOM, MOUTH_LEFT, MOUTH_RIGHT)).toSet() +
            (468 until 478)

    /**
     * Eye aspect ratio averaged over both eyes. Roughly 0.25-0.35 when open,
     * under ~0.2 when closed. Null if the mesh is incomplete.
     */
    fun eyeOpenness(points: List<PointF>): Float? {
        if (points.size < FULL_MESH_SIZE) return null
        return (eyeAspectRatio(points, RIGHT_EYE) + eyeAspectRatio(points, LEFT_EYE)) / 2f
    }

    /**
     * Mouth opening relative to mouth width. Near 0 when closed, above ~0.6
     * for a yawn. Null if the mesh is incomplete.
     */
    fun mouthOpenness(points: List<PointF>): Float? {
        if (points.size < FULL_MESH_SIZE) return null
        val width = dist(points[MOUTH_LEFT], points[MOUTH_RIGHT])
        if (width <= 0f) return null
        return dist(points[LIP_TOP], points[LIP_BOTTOM]) / width
    }

    /**
     * Rotates the mesh by a multiple of 90 degrees so the chin is below the
     * forehead, then mirrors it so it moves like a selfie preview. This makes
     * the drawing independent of the camera frame's orientation.
     */
    fun orientForDisplay(points: List<PointF>): List<PointF> {
        if (points.size < FULL_MESH_SIZE) return points
        val dx = points[CHIN].x - points[FOREHEAD].x
        val dy = points[CHIN].y - points[FOREHEAD].y
        val rotate: (PointF) -> PointF = when {
            abs(dy) >= abs(dx) && dy > 0 -> { p -> PointF(p.x, p.y) }
            abs(dy) >= abs(dx) -> { p -> PointF(-p.x, -p.y) }
            dx > 0 -> { p -> PointF(-p.y, p.x) }
            else -> { p -> PointF(p.y, -p.x) }
        }
        val upright = points.map(rotate)
        // In a mirrored (selfie) view the subject's right eye (33) is on the right.
        val mirrored = upright[RIGHT_EYE[0]].x < upright[LEFT_EYE[3]].x
        return if (mirrored) upright.map { PointF(-it.x, it.y) } else upright
    }

    private fun eyeAspectRatio(points: List<PointF>, eye: IntArray): Float {
        val p = eye.map { points[it] }
        val width = dist(p[0], p[3])
        if (width <= 0f) return 0f
        return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2f * width)
    }

    private fun dist(a: PointF, b: PointF): Float = hypot(a.x - b.x, a.y - b.y)
}
