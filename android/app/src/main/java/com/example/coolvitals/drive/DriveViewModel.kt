package com.example.coolvitals.drive

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * One [DriveUiState]. Speed comes from 1 Hz GPS fixes; limit, tier and the box levels come from the
 * backend's response to each 10 s window ([onWindowResult]). Nothing here touches the map, so a speed
 * tick never reaches it.
 */
class DriveViewModel : ViewModel() {
    var cutoffs = LevelCutoffs()
        set(value) {
            field = value
            publish()
        }

    private var permission = false
    private var lastFix: DriveFix? = null
    private var nowMs: Long = 0L
    private var window: WindowResult? = null
    private var speech: Level = Level.GOOD // ElevenLabs agent state is not wired yet: neutral
    private var route: String? = null

    private val _state = MutableStateFlow(build())
    val state: StateFlow<DriveUiState> = _state.asStateFlow()

    private var demo = false

    fun onPermission(granted: Boolean) {
        if (demo) return
        permission = granted
        publish()
    }

    fun onFix(fix: DriveFix) {
        lastFix = fix
        nowMs = fix.timeMs
        publish()
    }

    /** Called about once a second so a lost fix turns into "No GPS". */
    fun onTick(nowMs: Long) {
        this.nowMs = nowMs
        if (demo) lastFix = lastFix?.copy(timeMs = nowMs) // keep the fake fix fresh
        publish()
    }

    fun onWindowResult(r: WindowResult) {
        window = r
        publish()
    }

    fun setSpeech(level: Level) {
        speech = level
        publish()
    }

    fun setRoute(geoJson: String?) {
        route = geoJson
        publish()
    }

    /** Fake state for design work (build order step 1) and screenshots. */
    fun demo() {
        demo = true
        permission = true
        lastFix = DriveFix(speedMps = 23.2, courseDeg = 90.0, timeMs = System.currentTimeMillis())
        nowMs = lastFix!!.timeMs
        window = WindowResult(1, mapOf("distracted" to 0.1f, "phone" to 0.3f, "drowsy" to 0.9f), false, 55, LimitSource.OSM)
        publish()
    }

    private fun publish() {
        _state.update { build() }
    }

    private fun build(): DriveUiState {
        val fix = lastFix
        val age = fix?.let { nowMs - it.timeMs }
        val trip = tripStateOf(permission, age, fix?.speedMps)
        val gpsOn = trip != TripState.NO_GPS
        val w = window
        return DriveUiState(
            speedMph = if (gpsOn) mph(fix!!.speedMps) else null,
            limitMph = w?.limitMph,
            limitSource = w?.limitSource ?: LimitSource.NONE,
            tripState = trip,
            tier = w?.tier ?: 0,
            boxes = defaultBoxes(w?.levels ?: emptyMap(), w?.microsleep ?: false, speech, cutoffs),
            routeGeoJson = route,
        )
    }
}
