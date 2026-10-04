package com.example.coolvitals.drive

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.coolvitals.net.Backend
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One [DriveUiState]. Speed comes from 1 Hz GPS fixes; limit, tier and the box levels come from the
 * backend's response to each 10 s window ([onWindowResult]), which the [DriveSession] posts and feeds back.
 * Nothing here touches the map, so a speed tick never reaches it. The session lives here, not in the
 * activity, so a rotation does not start a second trip.
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
    private var online = true
    private var demo = false
    private var session: DriveSession? = null

    /** Presage metrics for the current window. The activity's [PresageSource] feeds it; it holds no Android objects. */
    val presage = PresageAggregator()
    @Volatile private var presageActive = false

    /** Turn the Presage fields on once the camera is running, off when it stops: no stale face data in a window. */
    fun setPresageActive(active: Boolean) {
        presageActive = active
    }

    private val presageSignals = SignalSource { if (presageActive) presage.snapshot() else emptyMap() }

    private val _state = MutableStateFlow(build())
    val state: StateFlow<DriveUiState> = _state.asStateFlow()

    fun onPermission(granted: Boolean) {
        if (demo) return
        permission = granted
        publish()
    }

    fun onFix(fix: DriveFix) {
        lastFix = fix
        nowMs = fix.timeMs
        session?.onFix(fix)
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

    /**
     * Starts posting windows to [backend]. Idempotent, and a no-op in demo mode. Call once location permission
     * is granted; the session keeps running across rotations and ends with the ViewModel.
     */
    fun startSession(backend: Backend, driverId: String, shareLocation: Boolean, signals: SignalSource = presageSignals) {
        if (session != null || demo) return
        session = DriveSession(
            backend = backend,
            driverId = driverId,
            shareLocation = shareLocation,
            signals = signals,
            onResult = { onWindowResult(it) },
            onConnection = { setOnline(it) },
        ).also { it.start(viewModelScope) }
    }

    /** App in the background: location is off, so post nothing rather than empty windows. */
    fun setActive(active: Boolean) {
        session?.paused = !active
    }

    private fun setOnline(value: Boolean) {
        if (online != value) {
            online = value
            publish()
        }
    }

    override fun onCleared() {
        // Activity finished for good (not a rotation): close the trip. Best effort, outlives viewModelScope.
        session?.let { s -> CoroutineScope(Dispatchers.IO).launch { s.stop() } }
        session = null
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
            online = online,
        )
    }
}
