package com.example.coolvitals.drive

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Up to 10 fixes per window, per the backend contract (more is a 400). */
const val MAX_FIXES_PER_WINDOW = 10

/**
 * Collects the 1 Hz fixes between two 10 s windows. Applies the backend's filter again (the location source
 * already did) so nothing bad can reach a payload, and keeps the newest [MAX_FIXES_PER_WINDOW].
 */
class FixBuffer {
    private val fixes = ArrayList<DriveFix>()

    @Synchronized
    fun add(fix: DriveFix) {
        if (isGoodFix(fix.accuracyM, fix.speedMps.toFloat())) fixes.add(fix)
    }

    /** The fixes for the window that just closed, oldest first. Empties the buffer. */
    @Synchronized
    fun drain(): List<DriveFix> {
        val out = fixes.sortedBy { it.timeMs }.takeLast(MAX_FIXES_PER_WINDOW)
        fixes.clear()
        return out
    }
}

/**
 * Where Presage metrics will come from. The Drive screen does not own the camera (Presage runs in
 * `MainActivity`), so today there is no source and those fields are left out, which the engine reads as "no
 * evidence". Keys are the backend's `SignalWindow` names: `face_visible`, `heart_rate`, `breathing_rate`,
 * `engagement`, `eye_closure_frac`, `longest_eye_closure_s`, `yawns`, `emotion_stress`, `gaze_off_road_s`,
 * `phone_in_hand`, `hard_brakes`, `swerves`.
 */
fun interface SignalSource {
    fun snapshot(): Map<String, Any?>
}

object NoSignals : SignalSource {
    override fun snapshot(): Map<String, Any?> = emptyMap()
}

object WindowPayload {
    fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString()

    fun fixJson(f: DriveFix): JSONObject = JSONObject()
        .put("t", iso(f.timeMs))
        .put("lat", f.lat)
        .put("lon", f.lon)
        .put("speed_mps", f.speedMps)
        .put("heading_deg", f.courseDeg ?: JSONObject.NULL)
        .put("h_accuracy_m", f.accuracyM.toDouble())

    /**
     * One 10 s window. `gps` is `{fixes}` when there is at least one good fix, else JSON null (no permission or
     * no fix: the backend then scores speeding as 0 instead of guessing). Presage fields are copied only when
     * the source supplied a value.
     */
    fun build(tsMs: Long, fixes: List<DriveFix>, signals: Map<String, Any?> = emptyMap()): JSONObject {
        val body = JSONObject().put("ts", iso(tsMs))
        signals.forEach { (k, v) -> if (v != null) body.put(k, v) }
        val last = fixes.takeLast(MAX_FIXES_PER_WINDOW)
        body.put("gps", if (last.isEmpty()) JSONObject.NULL else JSONObject().put("fixes", JSONArray(last.map { fixJson(it) })))
        return body
    }
}
