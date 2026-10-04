package com.example.coolvitals.drive

import com.example.coolvitals.net.Backend
import com.example.coolvitals.net.WindowReply
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

const val WINDOW_INTERVAL_MS = 10_000L
/** A fix this fast after a trip ended starts a new one (the backend's own start speed). */
const val RESTART_SPEED_MPS = 4.0

/**
 * One drive's conversation with the backend: create the trip, post a 10 s window (GPS only for now, see
 * [SignalSource]), hand each response to [onResult], end the trip when asked.
 *
 * It never throws and never blocks the screen: a dead backend only turns [onConnection] to false, and a lost
 * window is just lost. When the backend ends the trip by itself (stopped for 5 minutes) the session goes idle
 * and starts a new trip on the next fast fix. Not thread-safe except [onFix] and [paused].
 */
class DriveSession(
    private val backend: Backend,
    private val driverId: String,
    private val shareLocation: Boolean,
    private val signals: SignalSource = NoSignals,
    private val now: () -> Long = System::currentTimeMillis,
    private val onResult: (WindowResult) -> Unit,
    private val onConnection: (Boolean) -> Unit = {},
) {
    private val buffer = FixBuffer()
    private var tripId: String? = null
    private var idle = false
    private var lastTs = 0L
    private var lastFixSpeed = 0.0
    private var job: Job? = null

    /** While true (app in the background, location off) no windows are posted. */
    @Volatile var paused = false

    val currentTripId get() = tripId

    fun onFix(fix: DriveFix) {
        lastFixSpeed = fix.speedMps
        // Fixes are only worth keeping while a trip is open or about to be; idle waits for movement.
        if (idle && fix.speedMps <= RESTART_SPEED_MPS) return
        buffer.add(fix)
    }

    fun start(scope: CoroutineScope, intervalMs: Long = WINDOW_INTERVAL_MS) {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                delay(intervalMs)
                tick()
            }
        }
    }

    /** One 10 s step. Public so tests (and a replay) can drive it without waiting. */
    suspend fun tick() {
        if (paused) return
        if (idle) {
            if (lastFixSpeed <= RESTART_SPEED_MPS) return
            idle = false
        }
        val fixes = buffer.drain()
        val id = tripId ?: try {
            backend.startTrip(driverId, shareLocation).also { tripId = it; onConnection(true) }
        } catch (e: IOException) {
            onConnection(false)
            return
        }
        // Window time is the last fix's own time (so a replay keeps its own clock), else now; always increasing.
        val ts = maxOf(fixes.lastOrNull()?.timeMs ?: now(), lastTs + 1)
        lastTs = ts
        when (val reply = backend.postWindow(id, WindowPayload.build(ts, fixes, signals.snapshot()))) {
            is WindowReply.Ok -> {
                onConnection(true)
                onResult(reply.result)
                if (reply.result.tripEnded) finishTrip()
            }
            WindowReply.TripGone -> finishTrip()
            is WindowReply.Failed -> onConnection(false)
        }
    }

    private fun finishTrip() {
        tripId = null
        idle = true
    }

    /** Ends the open trip, if any, and stops the loop. */
    suspend fun stop() {
        job?.cancel()
        job = null
        tripId?.let { backend.endTrip(it) }
        tripId = null
    }
}
