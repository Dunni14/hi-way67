package com.example.coolvitals

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.util.AttributeSet
import android.view.View
import kotlin.math.min

/**
 * Draws the latest face landmarks as a dot mesh, fitted to this view.
 * Eyes, mouth and irises are highlighted. Dots are green when SmartSpectra
 * reports the landmarks as stable, orange otherwise.
 */
class FaceMeshView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private var points: List<PointF> = emptyList()
    private var stable = false

    private val dp = resources.displayMetrics.density
    private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(128, 0, 0, 0) }
    private val pointPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val featurePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.CYAN }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 12 * dp
        textAlign = Paint.Align.CENTER
    }

    fun setLandmarks(newPoints: List<PointF>, isStable: Boolean) {
        points = FaceGeometry.orientForDisplay(newPoints)
        stable = isStable
        invalidate()
    }

    fun clear() {
        points = emptyList()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        canvas.drawRoundRect(0f, 0f, w, h, 12 * dp, 12 * dp, backgroundPaint)

        if (points.isEmpty()) {
            canvas.drawText("No landmarks", w / 2, h / 2, textPaint)
            return
        }

        val minX = points.minOf { it.x }
        val maxX = points.maxOf { it.x }
        val minY = points.minOf { it.y }
        val maxY = points.maxOf { it.y }
        val spanX = (maxX - minX).coerceAtLeast(1f)
        val spanY = (maxY - minY).coerceAtLeast(1f)
        val pad = 10 * dp
        val scale = min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY)
        val offsetX = (w - spanX * scale) / 2
        val offsetY = (h - spanY * scale) / 2

        pointPaint.color = if (stable) Color.GREEN else Color.rgb(255, 165, 0)
        points.forEachIndexed { i, p ->
            val x = offsetX + (p.x - minX) * scale
            val y = offsetY + (p.y - minY) * scale
            if (i in FaceGeometry.FEATURE_POINTS) {
                canvas.drawCircle(x, y, 2f * dp, featurePaint)
            } else {
                canvas.drawCircle(x, y, 1f * dp, pointPaint)
            }
        }
    }
}
