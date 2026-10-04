package dev.driverguardian.trip

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.driverguardian.alarm.AlarmPlayer
import dev.driverguardian.data.AppSettings
import dev.driverguardian.data.SettingsStore
import dev.driverguardian.net.BackendClient
import dev.driverguardian.net.Conn
import dev.driverguardian.net.RiskApi
import dev.driverguardian.sensing.FakePresageSource
import dev.driverguardian.sensing.MotionSource
import dev.driverguardian.sensing.SmartSpectraPresageSource
import dg.core.BackendFrame
import dg.core.DemoScript
import dg.core.Dominant
import dg.core.PhoneFrame
import dg.core.Evaluation
import dg.core.ReportCard
import dg.core.ServerReport
import dg.core.SignalWindowBody
import dg.core.TripSummary
import dg.core.Verdict
import dg.core.RiskModel
import dg.core.TripEngine
import dg.core.WindowOutput
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.Calendar
import java.util.UUID

enum class EngineStatus { OFF, STARTING, ON, UNAVAILABLE }

/** Latest verdict from the backend risk engine (REST). Empty while the engine is off or has not answered yet. */
data class EngineUi(
    val status: EngineStatus = EngineStatus.OFF,
    val tier: Int = 0, // engine tiers 0..3
    val dominant: String = "", // "drowsy" | "reckless"
    val actions: List<String> = emptyList(),
    val levels: Map<String, Double> = emptyMap(),
    val override: String? = null,
    val degraded: Boolean = false,
    /** Window the feedback buttons apply to: the latest window that raised an alert. */
    val feedbackTs: String? = null,
    val feedbackNote: String? = null,
    val error: String? = null,
)

data class HistoryUi(val loading: Boolean = false, val trips: List<TripSummary> = emptyList(), val error: String? = null)

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
    /** The phone's own score, kept for the debug screen; [R] shows the engine's score when it is on. */
    val localR: Double = 0.0,
    val engine: EngineUi = EngineUi(),
)

/** Owns the trip lifecycle and the 10 s window loop. Phone reports, backend acts. */
@OptIn(ExperimentalCoroutinesApi::class)
class TripController(app: Application) : AndroidViewModel(app) {
    private val store = SettingsStore(app)
    private val alarm = AlarmPlayer(app)
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

    private val api = RiskApi { settings.host }
    private var tripId: String? = null
    private var engineQueue: Channel<SignalWindowBody>? = null
    private var engineJob: Job? = null
    @Volatile private var engineStatus = EngineStatus.OFF
    private val _serverReport = MutableStateFlow<ServerReport?>(null)
    val serverReport: StateFlow<ServerReport?> = _serverReport
    private val _history = MutableStateFlow(HistoryUi())
    val history: StateFlow<HistoryUi> = _history

    // Windows and alert tiers held for the current trip; the report card is computed from these locally.
    private val tripWindows = mutableListOf<PhoneFrame.RiskWindow>()
    private val tripAlerts = mutableListOf<Int>()
    private val _report = MutableStateFlow<ReportCard?>(null)
    val report: StateFlow<ReportCard?> = _report
    fun clearReport() { _report.value = null; _serverReport.value = null }

    init {
        viewModelScope.launch {
            settings = store.flow.first()
            if (settings.driverId.isBlank()) {
                settings = settings.copy(driverId = UUID.randomUUID().toString())
                store.update(settings)
            }
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
        engine = TripEngine(model).also { it.start(start) }
        client.send(PhoneFrame.TripStart)
        tripWindows.clear(); tripAlerts.clear(); _report.value = null; _serverReport.value = null
        _ui.value = _ui.value.copy(running = true, calibrating = true, tier = 0, engine = EngineUi())
        startEngine()

        val e = engine
        val demo = settings.demoMode
        val source = if (demo) FakePresageSource() else SmartSpectraPresageSource(getApplication())
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
            while (true) {
                delay(WINDOW_MS)
                closeWindow(e, start)
            }
        }
    }

    fun endTrip() {
        val wasRunning = tripJob != null
        tripJob?.cancel(); tripJob = null
        motion?.stop(); motion = null
        alarm.stop()
        client.send(PhoneFrame.TripEnd)
        if (wasRunning) _report.value = ReportCard.build(tripWindows.toList(), tripAlerts.toList())
        _ui.value = _ui.value.copy(running = false, calibrating = false, alarmOn = false, tier = 0)
        finishEngine(wasRunning)
    }

    // ---- backend risk engine (REST) ----

    /** Start a trip on the engine and post windows from a queue, in order. Failure leaves the phone scoring locally. */
    private fun startEngine() {
        engineJob?.cancel()
        if (!settings.useEngine) { engineStatus = EngineStatus.OFF; setEngine(EngineUi(EngineStatus.OFF)); return }
        val queue = Channel<SignalWindowBody>(64, BufferOverflow.DROP_OLDEST)
        engineQueue = queue
        engineStatus = EngineStatus.STARTING
        setEngine(EngineUi(EngineStatus.STARTING))
        val s = settings
        engineJob = viewModelScope.launch {
            val id = try {
                api.startTrip(s.driverId, s.kidsInCar, s.lowExperience, s.sleepHours, s.sharingMode)
            } catch (e: Exception) {
                android.util.Log.w("RiskApi", "engine unavailable, scoring on the phone: ${e.message}")
                engineStatus = EngineStatus.UNAVAILABLE
                setEngine(EngineUi(EngineStatus.UNAVAILABLE, error = e.message))
                queue.close()
                return@launch
            }
            tripId = id
            engineStatus = EngineStatus.ON
            setEngine(EngineUi(EngineStatus.ON))
            for (w in queue) {
                try {
                    onEvaluation(w.ts, api.sendWindow(id, w))
                } catch (e: Exception) {
                    // Transient failure: this window is not scored by the engine, so the phone gate covers alerts until the next one lands.
                    android.util.Log.w("RiskApi", "window ${w.ts}: ${e.message}")
                    engineStatus = EngineStatus.UNAVAILABLE
                    setEngine(_ui.value.engine.copy(status = EngineStatus.UNAVAILABLE, error = e.message))
                }
            }
        }
    }

    private fun onEvaluation(ts: String, ev: Evaluation) {
        engineStatus = EngineStatus.ON
        val alerted = ev.actions.any { it.startsWith("voice_") }
        if (alerted) {
            tripAlerts += when (ev.tier) { 3 -> 85; 2 -> 70; else -> 40 }
            if (ev.wantsAlarm) alarm.play()
        }
        val cur = _ui.value
        _ui.value = cur.copy(
            R = ev.score,
            tier = when (ev.tier) { 3 -> 85; 2 -> 70; 1 -> 40; else -> 0 },
            alarmOn = alarm.isPlaying,
            engine = EngineUi(
                status = EngineStatus.ON, tier = ev.tier, dominant = ev.dominant, actions = ev.actions, levels = ev.levels,
                override = ev.override, degraded = ev.degraded,
                feedbackTs = if (alerted) ts else cur.engine.feedbackTs,
                feedbackNote = if (alerted) null else cur.engine.feedbackNote,
            ),
        )
    }

    private fun setEngine(e: EngineUi) { _ui.value = _ui.value.copy(engine = e) }

    /** Tell the engine whether the last alert was right. A false alarm also silences the alarm. */
    fun sendFeedback(verdict: Verdict) {
        val id = tripId ?: return
        val ts = _ui.value.engine.feedbackTs ?: return
        if (verdict == Verdict.FALSE_ALARM) { alarm.stop(); _ui.value = _ui.value.copy(alarmOn = false) }
        viewModelScope.launch {
            val note = try {
                val r = api.feedback(id, ts, verdict)
                (if (verdict == Verdict.FALSE_ALARM) "Thanks, " else "Noted, ") + "${r.factor} weight now x%.2f".format(r.multiplier)
            } catch (e: Exception) { "Feedback failed: ${e.message}" }
            _ui.value = _ui.value.copy(engine = _ui.value.engine.copy(feedbackTs = null, feedbackNote = note))
        }
    }

    /** Drain the queue, close the trip and pull the engine's report card. */
    private fun finishEngine(wasRunning: Boolean) {
        val queue = engineQueue; val job = engineJob; val id = tripId
        engineQueue = null; engineJob = null; tripId = null
        queue?.close()
        engineStatus = EngineStatus.OFF
        if (!wasRunning || id == null) { job?.cancel(); return }
        viewModelScope.launch {
            job?.join()
            try {
                api.endTrip(id)
                _serverReport.value = api.report(id)
            } catch (e: Exception) { android.util.Log.w("RiskApi", "end/report: ${e.message}") }
        }
    }

    fun loadHistory() {
        val driver = settings.driverId
        if (driver.isBlank()) return
        _history.value = _history.value.copy(loading = true, error = null)
        viewModelScope.launch {
            _history.value = try {
                HistoryUi(trips = api.driverTrips(driver).sortedByDescending { it.startedAt })
            } catch (e: Exception) { HistoryUi(error = e.message ?: "failed") }
        }
    }

    private fun closeWindow(e: TripEngine, start: Long) {
        val now = System.currentTimeMillis()
        val hour = Calendar.getInstance().let { it.get(Calendar.HOUR_OF_DAY) + it.get(Calendar.MINUTE) / 60.0 }
        val out: WindowOutput = e.closeWindow(now, settings.kidsInCar, hour)
        client.sendWindow(out.window)
        if (!out.calibrating) tripWindows += out.window
        val engineOn = engineStatus == EngineStatus.ON || engineStatus == EngineStatus.STARTING
        if (engineOn) engineQueue?.trySend(out.signals)
        // While the engine is scoring it owns alerts (the backend maps its actions to voice and iMessage).
        // Sending the phone's alert as well would speak twice.
        if (!engineOn) out.alertTier?.let { tier ->
            tripAlerts += tier
            client.send(PhoneFrame.Alert(tier, out.dominant, out.result.R))
            if (tier == 85) { alarm.play() }
        }
        val g = e.gateState
        val left = ((60_000 - (now - start)) / 1000).toInt().coerceAtLeast(0)
        _ui.value = _ui.value.copy(
            calibrating = out.calibrating, calibrationLeftSec = left,
            cantSeeDriver = out.cantSeeDriver, distracted = out.distracted,
            R = if (_ui.value.engine.status == EngineStatus.ON) _ui.value.R else out.result.R,
            localR = out.result.R, drowsy = out.result.drowsy, reckless = out.result.reckless, m = out.result.m,
            dominant = out.dominant,
            tier = if (engineOn) _ui.value.tier else out.alertTier ?: if (out.result.R < 40) 0 else _ui.value.tier,
            speedMph = out.window.speed, features = out.features,
            alarmOn = alarm.isPlaying,
            weightsDrowsy = model.weights.drowsy.toMap(), weightsReckless = model.weights.reckless.toMap(),
            gateBand = g.currentBand, gateHeldSec = (g.bandHeldMs(now) / 1000).toInt(),
            cooldownSec = listOf(40, 70, 85).associateWith { (g.cooldownRemainingMs(it, now) / 1000).toInt() },
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
                is BackendFrame.Navigate -> onNavigate(f.query)
                is BackendFrame.Error -> android.util.Log.w("Backend", f.message)
                else -> {}
            }
        }
    }

    override fun onCleared() {
        endTrip(); client.disconnect()
    }

    companion object { const val WINDOW_MS = 10_000L }
}
