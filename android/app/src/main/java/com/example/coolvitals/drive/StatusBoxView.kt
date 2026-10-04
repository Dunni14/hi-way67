package com.example.coolvitals.drive

import android.animation.ArgbEvaluator
import android.animation.ValueAnimator
import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.widget.ImageViewCompat
import android.content.res.ColorStateList
import com.example.coolvitals.R
import com.google.android.material.card.MaterialCardView

/**
 * One status box. Frame, radius and minimum height never change; only the body does.
 * GREAT/GOOD: white card, coloured value. OK: white card, amber value. BAD: red card, white text and icon.
 * Level changes animate colour over 300 ms with no layout change.
 */
class StatusBoxView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : MaterialCardView(context, attrs) {

    var boxId: String = ""
        private set
    var level: Level? = null
        private set
    private var hasCustomContent = false
    private var animator: ValueAnimator? = null

    private val body: View
    private val icon: ImageView
    private val label: TextView
    private val value: TextView

    init {
        radius = resources.getDimension(R.dimen.drive_card_radius)
        cardElevation = 0f
        setCardBackgroundColor(ContextCompat.getColor(context, R.color.drive_card))
        minimumHeight = resources.getDimensionPixelSize(R.dimen.drive_box_min_height)
        LayoutInflater.from(context).inflate(R.layout.view_status_box, this, true)
        body = findViewById(R.id.boxBody)
        icon = findViewById(R.id.boxIcon)
        label = findViewById(R.id.boxLabel)
        value = findViewById(R.id.boxValue)
    }

    fun bind(box: StatusBox) {
        val changedId = boxId != box.id
        boxId = box.id

        // Click: null = static: not clickable, so it never shows a press ripple. Non-null = clickable; the
        // MaterialCardView draws its own ripple (it owns the foreground, so we leave that alone).
        if (box.onClick != null) {
            isClickable = true
            isFocusable = true
            setOnClickListener { box.onClick.invoke() }
        } else {
            setOnClickListener(null)
            isClickable = false
            isFocusable = false
        }

        if (box.content != null) {
            // Custom body replaces label/level; the card frame stays.
            if (!hasCustomContent || changedId) {
                removeAllViews()
                addView(box.content.invoke(context), ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                hasCustomContent = true
            }
            level = null
            contentDescription = box.label
            return
        }
        if (hasCustomContent) {
            removeAllViews()
            addView(body)
            hasCustomContent = false
        }

        label.text = box.label
        icon.setImageResource(box.icon)
        val levelText = context.getString(levelLabelRes(box.level)).uppercase()
        value.text = levelText
        contentDescription = "${box.label}: $levelText"
        applyLevel(box.level, animate = level != null && !changedId)
    }

    private fun applyLevel(newLevel: Level, animate: Boolean) {
        if (newLevel == level) return
        val from = currentColors()
        level = newLevel
        val to = colorsFor(newLevel)
        animator?.cancel()
        if (!animate) {
            apply(to)
            return
        }
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 300
            val ev = ArgbEvaluator()
            addUpdateListener {
                val f = it.animatedFraction
                apply(Colors(ev.evaluate(f, from.card, to.card) as Int, ev.evaluate(f, from.value, to.value) as Int, ev.evaluate(f, from.label, to.label) as Int, ev.evaluate(f, from.icon, to.icon) as Int))
            }
            start()
        }
    }

    private data class Colors(val card: Int, val value: Int, val label: Int, val icon: Int)

    private fun colorsFor(l: Level): Colors {
        fun c(r: Int) = ContextCompat.getColor(context, r)
        return when (l) {
            Level.BAD -> Colors(c(R.color.drive_bad), c(R.color.drive_on_bad), c(R.color.drive_on_bad), c(R.color.drive_on_bad))
            Level.OK -> Colors(c(R.color.drive_card), c(R.color.drive_ok), c(R.color.drive_label), c(R.color.drive_icon))
            Level.GOOD -> Colors(c(R.color.drive_card), c(R.color.drive_good), c(R.color.drive_label), c(R.color.drive_icon))
            Level.GREAT -> Colors(c(R.color.drive_card), c(R.color.drive_great), c(R.color.drive_label), c(R.color.drive_icon))
        }
    }

    private fun currentColors() = level?.let { colorsFor(it) } ?: colorsFor(Level.GREAT)

    private fun apply(c: Colors) {
        setCardBackgroundColor(c.card)
        value.setTextColor(c.value)
        label.setTextColor(c.label)
        ImageViewCompat.setImageTintList(icon, ColorStateList.valueOf(c.icon))
    }

    /** Colour the card is heading to (or at), for tests that should not wait for the animation. */
    fun targetCardColor(): Int = colorsFor(level ?: Level.GREAT).card

    private fun levelLabelRes(l: Level) = when (l) {
        Level.GREAT -> R.string.drive_level_great
        Level.GOOD -> R.string.drive_level_good
        Level.OK -> R.string.drive_level_ok
        Level.BAD -> R.string.drive_level_bad
    }
}
