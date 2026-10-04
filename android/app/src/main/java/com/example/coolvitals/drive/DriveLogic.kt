package com.example.coolvitals.drive

import com.example.coolvitals.R
import kotlin.math.max
import kotlin.math.roundToInt

// Pure rules behind the Drive screen. No Android views here, so they run as plain JVM unit tests.

const val MPS_TO_MPH = 2.23694
/** Heading is noise at low speed: hold the last bearing under this (same rule as the GPS spec). */
const val HOLD_BEARING_UNDER_MPS = 3.0
const val STOPPED_UNDER_MPS = 1.0
/** No good fix for this long means "No GPS". */
const val FIX_STALE_MS = 5_000L
/** Same fix filter as the backend: worse than this, or a negative speed, is dropped. */
const val MAX_ACCURACY_M = 30f

fun mph(mps: Double): Int = (mps * MPS_TO_MPH).roundToInt()

/** No evidence (null) counts as GREAT, like every other level in the engine. */
fun levelOf(value: Float?, c: LevelCutoffs = LevelCutoffs()): Level = when {
    value == null || value < c.great -> Level.GREAT
    value < c.good -> Level.GOOD
    value < c.ok -> Level.OK
    else -> Level.BAD
}

/** Eye Tracking: the drowsy level, but a microsleep (override) is always BAD. */
fun eyesLevel(drowsy: Float?, microsleep: Boolean, c: LevelCutoffs = LevelCutoffs()): Level =
    if (microsleep) Level.BAD else levelOf(drowsy, c)

/** Green at or under the limit (or with no limit to compare), red over it. */
fun isOverLimit(speedMph: Int?, limitMph: Int?): Boolean = speedMph != null && limitMph != null && speedMph > limitMph

fun limitText(limitMph: Int?, source: LimitSource): String = if (limitMph == null || source == LimitSource.NONE) "--" else limitMph.toString()

/** A small dot marks a limit that came from the hand-set road-class table, not an OSM tag. */
fun showFallbackDot(source: LimitSource, limitMph: Int?): Boolean = source == LimitSource.FALLBACK && limitMph != null

fun speedText(speedMph: Int?): String = speedMph?.toString() ?: "--"

/** Pill: title and subtitle ("Driving" over "Monitoring"). */
fun pillText(t: TripState, online: Boolean = true): Pair<String, String?> {
    val watching = if (online) "Monitoring" else "Offline"
    return when (t) {
        TripState.DRIVING -> "Driving" to watching
        TripState.STOPPED -> "Stopped" to watching
        TripState.NO_GPS -> "No GPS" to if (online) null else watching
    }
}

fun tripStateOf(permissionGranted: Boolean, lastFixAgeMs: Long?, speedMps: Double?): TripState = when {
    !permissionGranted || lastFixAgeMs == null || lastFixAgeMs > FIX_STALE_MS || speedMps == null -> TripState.NO_GPS
    speedMps < STOPPED_UNDER_MPS -> TripState.STOPPED
    else -> TripState.DRIVING
}

/** Keep the last bearing while slow; follow the course once moving. Null means "no bearing yet". */
fun heldBearing(speedMps: Double, course: Double?, last: Double?): Double? =
    if (speedMps >= HOLD_BEARING_UNDER_MPS && course != null) course else last

/** Fix filter shared with the backend: accuracy 30 m or better and a speed that is not negative. */
fun isGoodFix(accuracyM: Float?, speedMps: Float?): Boolean =
    accuracyM != null && accuracyM >= 0f && accuracyM <= MAX_ACCURACY_M && speedMps != null && speedMps >= 0f

fun boxRows(count: Int): Int = (count + 1) / 2

/**
 * Tallest the status grid may be: whatever is left after the header, nav, gaps and the map's minimum.
 * Past that the grid scrolls and the map keeps its minimum height.
 */
fun gridMaxHeightPx(rootHeight: Int, paddingTotal: Int, headerHeight: Int, navHeight: Int, gap: Int, mapMin: Int): Int =
    max(0, rootHeight - paddingTotal - headerHeight - navHeight - 3 * gap - mapMin)

data class Banner(val textRes: Int, val colorRes: Int)

/** Alert banner over the map, by decision-tree tier. Null at tier 0. */
fun bannerFor(tier: Int): Banner? = when (tier) {
    1 -> Banner(R.string.drive_banner_1, R.color.drive_banner_1)
    2 -> Banner(R.string.drive_banner_2, R.color.drive_banner_2)
    3 -> Banner(R.string.drive_banner_3, R.color.drive_banner_3)
    else -> null
}

/** The four default boxes from the engine's levels. Speech is the ElevenLabs agent state, passed in. */
fun defaultBoxes(
    levels: Map<String, Float>,
    microsleep: Boolean,
    speech: Level,
    cutoffs: LevelCutoffs = LevelCutoffs(),
    labels: (String) -> String = { it },
): List<StatusBox> = listOf(
    StatusBox("attention", labels("Attention"), levelOf(levels["distracted"], cutoffs), R.drawable.ic_box_attention),
    StatusBox("distraction", labels("Distraction"), levelOf(levels["phone"], cutoffs), R.drawable.ic_box_distraction),
    StatusBox("eyes", labels("Eye Tracking"), eyesLevel(levels["drowsy"], microsleep, cutoffs), R.drawable.ic_box_eyes),
    StatusBox("speech", labels("Speech"), speech, R.drawable.ic_box_speech),
)
