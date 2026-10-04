package com.example.coolvitals.drive

import android.content.Context
import android.view.View
import androidx.annotation.DrawableRes

enum class Level { GREAT, GOOD, OK, BAD }

enum class TripState { DRIVING, STOPPED, NO_GPS }

/** Where the posted limit came from (backend `gps.limit_source`). */
enum class LimitSource {
    OSM, FALLBACK, NONE;

    companion object {
        fun parse(s: String?) = when (s?.lowercase()) {
            "osm" -> OSM
            "fallback" -> FALLBACK
            else -> NONE
        }
    }
}

/**
 * One status box. The screen never hardcodes the boxes: it takes a list of these.
 *  - [onClick] null: static box, no ripple. Non-null: clickable with ripple.
 *  - [content] non-null: custom body (sparkline, toggle, mic button...) in the same card frame,
 *    overriding label and level.
 */
data class StatusBox(
    val id: String,
    val label: String,
    val level: Level,
    @DrawableRes val icon: Int,
    val onClick: (() -> Unit)? = null,
    val content: ((Context) -> View)? = null,
)

/** 0..1 level cutoffs: under [great] GREAT, under [good] GOOD, under [ok] OK, else BAD. Hand-set. */
data class LevelCutoffs(val great: Float = 0.25f, val good: Float = 0.5f, val ok: Float = 0.75f)

data class DriveUiState(
    val speedMph: Int?,
    val limitMph: Int?,
    val limitSource: LimitSource,
    val tripState: TripState,
    /** 0 to 3 from the decision tree. */
    val tier: Int,
    val boxes: List<StatusBox>,
    val routeGeoJson: String?,
    val driverInitial: String = "D",
    /** False while the backend cannot be reached (shown in the pill). */
    val online: Boolean = true,
)
