package com.example.coolvitals.drive

import org.json.JSONObject

/**
 * What the Drive screen needs from the backend's response to `POST /trips/{id}/windows`
 * (docs/risk-engine.md). Fields it does not use are ignored.
 */
data class WindowResult(
    val tier: Int,
    val levels: Map<String, Float>,
    val microsleep: Boolean,
    val limitMph: Int?,
    val limitSource: LimitSource,
    /** The backend ended the trip on this window (stopped long enough): stop sending. */
    val tripEnded: Boolean = false,
) {
    companion object {
        fun fromJson(json: String): WindowResult {
            val o = JSONObject(json)
            val levels = o.optJSONObject("levels")?.let { l -> l.keys().asSequence().associateWith { l.optDouble(it, 0.0).toFloat() } } ?: emptyMap()
            val gps = o.optJSONObject("gps")
            return WindowResult(
                tier = o.optInt("tier", 0),
                levels = levels,
                microsleep = o.optString("override") == "microsleep",
                limitMph = gps?.takeIf { !it.isNull("limit_mph") }?.optInt("limit_mph"),
                limitSource = LimitSource.parse(gps?.optString("limit_source")),
                tripEnded = gps?.optBoolean("trip_ended", false) ?: false,
            )
        }
    }
}
