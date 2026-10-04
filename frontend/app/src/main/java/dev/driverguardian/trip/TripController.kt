package dev.driverguardian.trip

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.driverguardian.alarm.AlarmPlayer
import dev.driverguardian.data.AppSettings
import dev.driverguardian.data.SettingsStore
import dev.driverguardian.data.TripHistoryStore
import dev.driverguardian.net.BackendClient
import dev.driverguardian.net.Conn
import dev.driverguardian.sensing.FakePresageSource
import dev.driverguardian.sensing.MotionSource
import dev.driverguardian.sensing.SmartSpectraPresageSource
import dev.driverguardian.voice.VoicePlayer
import dg.core.BackendFrame
import dg.core.ContactInfo
import dg.core.DemoClock
import dg.core.DemoScript
import dg.core.Dominant
import dg.core.PhoneFrame
import dg.core.RealClock
import dg.core.ReportCard
import dg.core.TripClock
import dg.core.SpeedTracker
import dg.core.TripHistory
import dg.core.TripRecap
import dg.core.TripSample
import dg.core.TripSummary
import dg.core.WindowAggregator
import dg.core.WindowSignals
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

data class UiState(
    val running: Boolean = false,
    val calibrating: Boolean = false,
    val calibrationLeftSec: Int = 0,
    val cantSeeDriver: Boolean = false,
    // The backend risk engine's latest verdict (one per 10 s window).
    val score: Double = 0.0,
    val tier: Int = 0, // 0..3
    val dominant: Dominant = Dominant.DROWSY,
    val levels: Map<String, Double> = emptyMap(), // drowsy, agitated, speeding, phone, distracted, erratic (0..1)
    val override: String? = null,
    val degraded: Boolean = false,
    val lastActions: List<String> = emptyList(),
    val speedMph: Double = 0.0,
    val alarmOn: Boolean = false,
    // Engine feedback after "I'm fine": which factor's weight it eased for this driver, and to what.
    val feedbackFactor: String? = null,
    val feedbackMultiplier: Double? = null,
    // What the phone sent last, for the debug screen.
    val lastSignals: WindowSignals? = null,
    val windowsSent: Int = 0,
    // Live ~1 Hz Presage values.
    val liveEyeClosed: Double? = null,
    val liveHeartRate: Double? = null,
    val talking: Boolean? = null,
    val mouthOpen: Double? = null,
    val faceVisible: Boolean = false,
    val yawnCount: Int = 0,
    val lastYawnAtMs: Long = 0,
)

/** Contacts tab: the backend's allowlist and the invite being shared. */
data class ContactsState(
    val loaded: Boolean = false,
    val list: List<ContactInfo> = emptyList(),
    val groupBound: Boolean = false,
    val groupLink: String? = null,
    val inviting: Boolean = false, // contact_add sent, waiting for contact_invite or error
    val invite: BackendFrame.ContactInvite? = null,
    val error: String? = null,
    val joined: String? = null, // "Sam joined" banner
)

/**
 * Owns the trip lifecycle and the 10 s window loop. The phone senses and displays: every window of
 * raw signals goes to the backend, whose risk engine scores it and decides every alert (voice,
 * contacts). Its verdict comes back as an `evaluation` frame.
 */
class TripController(app: Application) : AndroidViewModel(app) {
    private val store = SettingsStore(app)
    private val alarm = AlarmPlayer(app)
    private val wakeSound = dev.driverguardian.alarm.SoundPlayer(app)
    private val voice = VoicePlayer(app) { client.send(it) }
    private var settings = AppSettings()
    private var tripJob: Job? = null
    private var motion: MotionSource? = null

    private val _ui = MutableStateFlow(UiState())
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
    val voiceState: StateFlow<VoicePlayer.State> = voice.state
    /** Trip history from the backend risk engine (Tiger Data), on the current host. */
    val history = dev.driverguardian.net.HistoryApi { settings.host }

    // This trip's windows (events by ts) and the engine's verdicts; the report card is built from these.
    private val sentEvents = mutableMapOf<Long, List<String>>()
    private val samples = mutableListOf<TripSample>()
    private val _report = MutableStateFlow<ReportCard?>(null)
    val report: StateFlow<ReportCard?> = _report

    /** The report the backend generated at trip end and shared with friends and family; arrives shortly after [endTrip]. */
    private val _sharedReport = MutableStateFlow<BackendFrame.Report?>(null)
    val sharedReport: StateFlow<BackendFrame.Report?> = _sharedReport

    // Finished trips, newest first, kept on the phone for the Stats tab.
    private val historyStore = TripHistoryStore(app)
    private val _history = MutableStateFlow<List<TripSummary>>(emptyList())
    val localHistory: StateFlow<List<TripSummary>> = _history
    private var tripDemo = false

    // End-of-trip popup: speeds seen during the trip plus the engine's alertness, until dismissed.
    private var speed = SpeedTracker()
    private val _recap = MutableStateFlow<TripRecap?>(null)
    val recap: StateFlow<TripRecap?> = _recap
    fun dismissRecap() { _recap.value = null }

    /** Pacing of the current trip: [DemoClock] in demo mode, else real time. */
    private var clock: TripClock = RealClock
    private var tripStartMs = 0L

    init {
        viewModelScope.launch {
            settings = store.flow.first()
            _settings.value = settings
            client.connect(settings.host)
        }
        viewModelScope.launch { _history.value = historyStore.load() }
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
        tripStartMs = start
        val demo = settings.demoMode
        tripDemo = demo
        // Demo mode sends windows faster (DemoClock: one per 10 script seconds) but stamps them in real
        // time, so the engine's window-counted holds speed up while its cooldowns stay real.
        val c: TripClock = if (demo) DemoClock else RealClock
        clock = c
        client.send(PhoneFrame.TripStart)
        sentEvents.clear(); samples.clear(); _report.value = null; _sharedReport.value = null
        speed = SpeedTracker(); _recap.value = null
        _ui.value = UiState(running = true, calibrating = true, calibrationLeftSec = calibrationLeftSec())

        val agg = WindowAggregator()
        val source = if (demo) FakePresageSource(c) else SmartSpectraPresageSource(getApplication())
        if (demo) {
            agg.onMotion(DemoScript.DEMO_SPEED_MPH, 42.2808, -83.743)
        } else {
            motion = MotionSource(getApplication(),
                onMotion = { mph, lat, lon -> viewModelScope.launch { speed.add(mph); agg.onMotion(mph, lat, lon) } },
                onEvent = { ev -> viewModelScope.launch { agg.onImuEvent(ev) } },
            ).also { it.start() }
        }
        tripJob = viewModelScope.launch {
            launch {
                source.frames(start).collect { f ->
                    agg.onPresage(f)
                    val u = _ui.value
                    _ui.value = u.copy(
                        faceVisible = f.confidence >= WindowAggregator.MIN_CONFIDENCE,
                        liveEyeClosed = f.eyeClosed, liveHeartRate = f.heartRate ?: u.liveHeartRate,
                        talking = f.talking, mouthOpen = f.mouthOpen,
                        yawnCount = u.yawnCount + if (f.yawn) 1 else 0,
                        lastYawnAtMs = if (f.yawn) System.currentTimeMillis() else u.lastYawnAtMs,
                    )
                }
            }
            // The countdown ticks every second; the windows below only close every 10 s.
            launch {
                while (true) {
                    val left = calibrationLeftSec()
                    if (_ui.value.calibrationLeftSec != left) _ui.value = _ui.value.copy(calibrationLeftSec = left)
                    if (left == 0) break
                    delay(200)
                }
            }
            // A window closes every WINDOW_MS of script time, paced in real time by the clock.
            var scriptMs = 0L
            var lastTs = 0L
            while (true) {
                scriptMs += WINDOW_MS
                val wait = start + c.realMs(scriptMs) - System.currentTimeMillis()
                if (wait > 0) delay(wait)
                val ts = maxOf(System.currentTimeMillis(), lastTs + 1) // real time, unique per window
                lastTs = ts
                sendWindow(agg.close(ts))
            }
        }
    }

    fun endTrip() {
        val wasRunning = tripJob != null
        tripJob?.cancel(); tripJob = null
        motion?.stop(); motion = null
        alarm.stop()
        client.send(PhoneFrame.TripEnd)
        if (wasRunning) {
            val card = ReportCard.build(samples.toList())
            _report.value = card
            if (card != null) {
                val updated = TripHistory.add(_history.value, TripSummary.of(card, System.currentTimeMillis(), tripDemo, speed))
                _history.value = updated
                viewModelScope.launch { historyStore.save(updated) }
            }
            _recap.value = TripRecap.of(System.currentTimeMillis() - tripStartMs, speed, card)
        }
        _ui.value = _ui.value.copy(running = false, calibrating = false, alarmOn = false)
    }

    private fun sendWindow(w: PhoneFrame.RiskWindow) {
        client.sendWindow(w)
        sentEvents[w.ts] = w.events
        if (tripDemo) speed.add(w.speed) // demo mode has no GPS callbacks; its speed only shows up in the windows
        val u = _ui.value
        _ui.value = u.copy(lastSignals = w.signals, windowsSent = u.windowsSent + 1, speedMph = w.speed, calibrationLeftSec = calibrationLeftSec())
    }

    /** Real seconds of calibration left, rounded up so it starts at the full length and ends on 0. */
    private fun calibrationLeftSec(): Int =
        ((tripStartMs + clock.realMs(CALIBRATION_MS) - System.currentTimeMillis() + 999) / 1000).toInt().coerceAtLeast(0)

    /** The engine's verdict on one of our windows: update the screen, sound the alarm on an urgent alert. */
    private fun onEvaluation(e: BackendFrame.Evaluation) {
        if (tripJob == null) return // late frame after the trip ended
        val alerted = e.actions.any { it.startsWith("voice_") }
        if ("voice_urgent" in e.actions) alarm.play()
        if (!e.calibrating) samples += TripSample(e.ts, e.score, e.tier, e.dominant, alerted, sentEvents.remove(e.ts).orEmpty())
        val face = _ui.value.lastSignals?.faceVisible
        _ui.value = _ui.value.copy(
            calibrating = e.calibrating,
            score = e.score, tier = e.tier, dominant = e.dominant, levels = e.levels,
            override = e.override, degraded = e.degraded, lastActions = e.actions,
            cantSeeDriver = e.degraded || face == false,
            alarmOn = alarm.isPlaying,
        )
    }

    private fun onBackend(f: BackendFrame) {
        viewModelScope.launch {
            when (f) {
                is BackendFrame.Evaluation -> onEvaluation(f)
                is BackendFrame.Dismissed -> {
                    alarm.stop()
                    _ui.value = _ui.value.copy(alarmOn = false, feedbackFactor = f.factor, feedbackMultiplier = f.multiplier)
                }
                is BackendFrame.Speak -> voice.play(f)
                is BackendFrame.Report -> _sharedReport.value = f
                is BackendFrame.Navigate -> onNavigate(f.query)
                is BackendFrame.PlaySound -> wakeSound.play(f.id)
                is BackendFrame.Alarm -> { alarm.play(); _ui.value = _ui.value.copy(alarmOn = true) }
                is BackendFrame.Error -> { android.util.Log.w("Backend", f.message); onContactsFrame(f) }
                is BackendFrame.Contacts, is BackendFrame.ContactInvite, is BackendFrame.ContactJoined -> onContactsFrame(f)
                else -> {}
            }
        }
    }

    private val _contacts = MutableStateFlow(ContactsState())
    val contacts: StateFlow<ContactsState> = _contacts

    fun refreshContacts() = client.send(PhoneFrame.ContactsList)

    /** Telegram invite: the backend answers with contact_invite (or an error). */
    fun addContact(name: String, guardian: Boolean) {
        _contacts.value = _contacts.value.copy(inviting = true, invite = null, error = null)
        client.send(PhoneFrame.ContactAdd(name.trim(), if (guardian) "guardian" else "friend", "telegram"))
    }

    fun removeContact(handle: String) {
        _contacts.value = _contacts.value.copy(list = _contacts.value.list.filterNot { it.handle == handle })
        client.send(PhoneFrame.ContactRemove(handle))
    }

    fun setGuardian(handle: String, on: Boolean) {
        val role = if (on) "guardian" else "friend"
        _contacts.value = _contacts.value.copy(list = _contacts.value.list.map { if (it.handle == handle) it.copy(role = role) else it })
        client.send(PhoneFrame.ContactUpdate(handle, role))
    }

    fun clearInvite() { _contacts.value = _contacts.value.copy(inviting = false, invite = null, error = null) }
    fun clearJoined() { _contacts.value = _contacts.value.copy(joined = null) }

    private fun onContactsFrame(f: BackendFrame) {
        val c = _contacts.value
        _contacts.value = when (f) {
            is BackendFrame.Contacts -> c.copy(loaded = true, list = f.list, groupBound = f.groupBound, groupLink = f.groupLink)
            is BackendFrame.ContactInvite -> c.copy(inviting = false, invite = f)
            is BackendFrame.ContactJoined -> c.copy(joined = "${f.name} joined as ${if (f.role == "guardian") "a guardian" else "a friend"}").also { refreshContacts() }
            is BackendFrame.Error -> if (c.inviting) c.copy(inviting = false, error = f.message) else c
            else -> c
        }
    }

    override fun onCleared() {
        endTrip(); voice.release(); client.disconnect()
    }

    companion object {
        const val WINDOW_MS = 10_000L
        const val CALIBRATION_MS = 60_000L // the engine's 6 baseline windows
    }
}
