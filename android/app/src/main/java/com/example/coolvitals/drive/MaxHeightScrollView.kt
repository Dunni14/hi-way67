package com.example.coolvitals.drive

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.ScrollView

/** A ScrollView that wraps its content up to [maxHeightPx], then scrolls. */
class MaxHeightScrollView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ScrollView(context, attrs) {
    var maxHeightPx: Int = Int.MAX_VALUE
        set(value) {
            if (field != value) {
                field = value
                requestLayout()
            }
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val capped = View.MeasureSpec.makeMeasureSpec(maxHeightPx.coerceAtLeast(0), View.MeasureSpec.AT_MOST)
        // Only cap when the parent would let us wrap; an exact height is respected.
        val spec = if (View.MeasureSpec.getMode(heightMeasureSpec) == View.MeasureSpec.EXACTLY) heightMeasureSpec else capped
        super.onMeasure(widthMeasureSpec, spec)
    }
}
