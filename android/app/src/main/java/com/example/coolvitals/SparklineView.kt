package com.example.coolvitals

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import java.util.Locale

/**
 * Rolling line graph of one value over the last [windowMs], auto-scaled to
 * the visible range. Used for heart rate now; meant for the risk score later.
 */
class SparklineView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    var label: String = ""
    var windowMs: Long = 60_000

    private val samples = ArrayDeque<Pair<Long, Float>>()

    private val dp = resources.displayMetrics.density
    private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(128, 0, 0, 0) }
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 82, 82)
        style = Paint.Style.STROKE
        strokeWidth = 2 * dp
        strokeJoin = Paint.Join.ROUND
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 12 * dp
    }
    private val path = Path()

    fun add(value: Float, now: Long = SystemClock.elapsedRealtime()) {
        samples.addLast(now to value)
        while (samples.isNotEmpty() && samples.first().first < now - windowMs) samples.removeFirst()
        invalidate()
    }

    fun clear() {
        samples.clear()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        canvas.drawRoundRect(0f, 0f, w, h, 12 * dp, 12 * dp, backgroundPaint)

        val latest = samples.lastOrNull()?.second
        val title = if (latest == null) label else String.format(Locale.ROOT, "%s  %.0f", label, latest)
        canvas.drawText(title, 8 * dp, 16 * dp, textPaint)
        if (samples.size < 2) return

        val now = samples.last().first
        val minV = samples.minOf { it.second }
        val maxV = samples.maxOf { it.second }
        val range = (maxV - minV).coerceAtLeast(1f)
        val top = 24 * dp
        val bottom = h - 8 * dp
        val left = 8 * dp
        val right = w - 8 * dp

        path.reset()
        samples.forEachIndexed { i, (t, v) ->
            val x = right - (now - t).toFloat() / windowMs * (right - left)
            val y = bottom - (v - minV) / range * (bottom - top)
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, linePaint)
    }
}
