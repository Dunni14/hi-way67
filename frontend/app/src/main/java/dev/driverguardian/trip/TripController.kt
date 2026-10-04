package dev.driverguardian.trip

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.driverguardian.alarm.AlarmPlayer
import dev.driverguardian.data.AppSettings
import dev.driverguardian.data.SettingsStore
import dev.driverguardian.net.BackendClient
import dev.driverguardian.net.Conn
import dev.driverguardian.sensing.FakePresageSource
import dev.driverguardian.sensing.MotionSource
import dev.driverguardian.sensing.SmartSpectraPresageSource
import dev.driverguardian.voice.VoicePlayer
import dg.core.AlertGate
import dg.core.BackendFrame
import dg.core.DemoClock
import dg.core.DemoScript
import dg.core.Dominant
import dg.core.PhoneFrame
import dg.core.RealClock
import dg.core.ReportCard
import dg.core.RiskModel
import dg.core.TripClock
import dg.core.TripEngine
import dg.core.WindowOutput
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.Calendar

data class UiState(
    val running: Boolean = false,
    val calibrating: Boolean = false,
    val calibrationLeftSec: Int = 0,
    val cantSeeDriver: Boolean = false,
    val distracted: Boolean = false,
    val R: Double = 0.0,
    val drowsy: Double = 0.0,
    val reckless: Double = 0.0,
    val m: Double = 1.0,
    val dominant: Dominant = Dominant.DROWSY,
    val tier: Int = 0, // highest tier fired most recently, shown until the next window drops below it
    val speedMph: Double = 0.0,
    val features: Map<String, Double?> = emptyMap(),
    val alarmOn: Boolean = false,
    val weightsDrowsy: Map<String, Double> = emptyMap(),
    val weightsReckless: Map<String, Double> = emptyMap(),
    val nudgeBefore: Map<String, Double> = emptyMap(),
    val nudgeDominant: Dominant? = null,
    val gateBand: Int = 0,
    val gateHeldSec: Int = 0,
    val cooldownSec: Map<Int, Int> = emptyMap(),
)

/** Owns the trip lifecycle and the 10 s window loop. Phone reports, backend acts. */
@OptIn(ExperimentalCoroutinesApi::class)
class TripController(app: Application) : AndroidViewModel(app) {
    private val store = SettingsStore(app)
    private val alarm = AlarmPlayer(app)
    private val voice = VoicePlayer(app) { client.send(it) }
    private val model = RiskModel() // weights live for the process so nudges persist across trips
    private var engine = TripEngine(model)
    private var settings = AppSettings()
    private var tripJob: Job? = null
    private var motion: MotionSource? = null

    private val _ui = MutableStateFlow(UiState(weightsDrowsy = model.weights.drowsy.toMap(), weightsReckless = model.weights.reckless.toMap()))
    val ui: StateFlow<UiState> = _ui
    private val _settings = MutableStateFlow(settings)
    val settingsFlow: StateFlow<AppSettings> = _settings

    /** Set by the activity: open maps for a `navigate` frame. */
    var onNavigate: (String) -> Unit = {}

    val client = BackendClient(
        scope = viewModelScope,
        hello = { PhoneFrame.Hello(settings.driverName.ifBlank { null }, settings.sharingMode, settings.kidsInCar) },
        onFrame = ::onBackend,
    )
    val connection: StateFlow<Conn> = client.state

    // Windows and alert tiers held for the current trip; the report card is computed from these locally.
    private val tripWindows = mutableListOf<PhoneFrame.RiskWindow>()
    private val tripAlerts = mutableListOf<Int>()
    private val _report = MutableStateFlow<ReportCard?>(null)
    val report: StateFlow<ReportCard?> = _report
    fun clearReport() { _report.value = null }

    init {
        viewModelScope.launch {
            settings = store.flow.first()
            _settings.value = settings
            client.connect(settings.host)
        }
    }

    fun saveSettings(s: AppSettings) {
        val old = settings
        settings = s
        _settings.value = s
        viewModelScope.launch { store.update(s) }
        if (s.host != old.host) client.connect(s.host)
        if (s.sharingMode != old.sharingMode || s.kidsInCar != old.kidsInCar) {
            client.send(PhoneFrame.Settings(
                sharingMode = s.sharingMode.takeIf { it != old.sharingMode },
                kidsInCar = s.kidsInCar.takeIf { it != old.kidsInCar },
            ))
        }
    }

    fun startTrip() {
        if (tripJob?.isActive == true) return
        client.connect(settings.host)
        val start = System.currentTimeMillis()
        val demo = settings.demoMode
        // Demo mode runs the whole pipeline (calibration, smoothing, hold, script) on DemoClock's paced
        // script time. Cooldowns are scaled so alarms and group alerts repeat at most every 2 real minutes.
        val c: TripClock = if (demo) DemoClock else RealClock
        clock = c
        engine = TripEngine(model, gate = AlertGate(cooldownMs = (COOLDOWN_MS * c.steadyRate).toLong())).also { it.start(start) }
        client.send(PhoneFrame.TripStart)
        tripWindows.clear(); tripAlerts.clear(); _report.value = null
        _ui.value = _ui.value.copy(running = true, calibrating = true, tier = 0)

        val e = engine
        val source = if (demo) FakePresageSource(c) else SmartSpectraPresageSource(getApplication())
        if (demo) {
            e.onMotion(DemoScript.DEMO_SPEED_MPH, 42.2808, -83.743)
        } else {
            motion = MotionSource(getApplication(),
                onMotion = { mph, lat, lon -> viewModelScope.launch { e.onMotion(mph, lat, lon) } },
                onEvent = { ev -> viewModelScope.launch { e.onImuEvent(ev) } },
            ).also { it.start() }
        }
        tripJob = viewModelScope.launch {
            launch { source.frames(start).collect { e.onPresage(it) } }
            // Windows close every WINDOW_MS of script time, paced in real time by the clock.
            var scriptMs = 0L
            while (true) {
                scriptMs += WINDOW_MS
                val wait = start + c.realMs(scriptMs) - System.currentTimeMillis()
                if (wait > 0) delay(wait)
                closeWindow(e, start, scriptMs)
            }
        }
    }

    /** Pacing of the current trip: [DemoClock] in demo mode, else real time. */
    private var clock: TripClock = RealClock

    fun endTrip() {
        val wasRunning = tripJob != null
        tripJob?.cancel(); tripJob = null
        motion?.stop(); motion = null
        alarm.stop()
        client.send(PhoneFrame.TripEnd)
        if (wasRunning) _report.value = ReportCard.build(tripWindows.toList(), tripAlerts.toList())
        _ui.value = _ui.value.copy(running = false, calibrating = false, alarmOn = false, tier = 0)
    }

    private fun closeWindow(e: TripEngine, start: Long, scriptMs: Long) {
        val c = clock
        val realNow = System.currentTimeMillis()
        val now = start + scriptMs // engine clock (paced script time in demo mode)
        // Script-to-real factor right now, so the debug timers read in real seconds.
        val rate = if (c === DemoClock && scriptMs < DemoClock.FAST_UNTIL_MS) DemoClock.FAST_RATE else c.steadyRate
        val toRealSec = { scriptSpanMs: Long -> (scriptSpanMs / 1000.0 / rate).toInt() }
        val hour = Calendar.getInstance().let { it.get(Calendar.HOUR_OF_DAY) + it.get(Calendar.MINUTE) / 60.0 }
        val out: WindowOutput = e.closeWindow(now, settings.kidsInCar, hour)
        // The backend and the report card work in real time.
        val window = out.window.copy(ts = realNow)
        client.sendWindow(window)
        if (!out.calibrating) tripWindows += window
        out.alertTier?.let { tier ->
            tripAlerts += tier
            client.send(PhoneFrame.Alert(tier, out.dominant, out.result.R))
            if (tier == 85) { alarm.play() }
        }
        val g = e.gateState
        // UI shows real seconds.
        val left = ((start + c.realMs(CALIBRATION_MS) - realNow) / 1000).toInt().coerceAtLeast(0)
        _ui.value = _ui.value.copy(
            calibrating = out.calibrating, calibrationLeftSec = left,
            cantSeeDriver = out.cantSeeDriver, distracted = out.distracted,
            R = out.result.R, drowsy = out.result.drowsy, reckless = out.result.reckless, m = out.result.m,
            dominant = out.dominant, tier = out.alertTier ?: if (out.result.R < 40) 0 else _ui.value.tier,
            speedMph = out.window.speed, features = out.features,
            alarmOn = alarm.isPlaying,
            weightsDrowsy = model.weights.drowsy.toMap(), weightsReckless = model.weights.reckless.toMap(),
            gateBand = g.currentBand, gateHeldSec = toRealSec(g.bandHeldMs(now)),
            cooldownSec = listOf(40, 70, 85).associateWith { toRealSec(g.cooldownRemainingMs(it, now)) },
        )
    }

    private fun onBackend(f: BackendFrame) {
        viewModelScope.launch {
            when (f) {
                BackendFrame.Dismissed -> {
                    alarm.stop()
                    val d = model.latestDominant
                    val n = model.weights.nudge(d, model.latestX)
                    _ui.value = _ui.value.copy(
                        alarmOn = false, nudgeBefore = n.before, nudgeDominant = d,
                        weightsDrowsy = model.weights.drowsy.toMap(), weightsReckless = model.weights.reckless.toMap(),
                    ) // cooldowns keep running
                }
                is BackendFrame.Speak -> voice.play(f)
                is BackendFrame.Navigate -> onNavigate(f.query)
                is BackendFrame.Error -> android.util.Log.w("Backend", f.message)
                else -> {}
            }
        }
    }

    override fun onCleared() {
        endTrip(); voice.release(); client.disconnect()
    }

    companion object {
        const val WINDOW_MS = 10_000L
        const val CALIBRATION_MS = 60_000L // TripEngine default
        const val COOLDOWN_MS = 120_000L // AlertGate default, in real time
    }
}
