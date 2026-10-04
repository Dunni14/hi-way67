package dev.driverguardian.net

import dg.core.BackendFrame
import dg.core.CLOSE_REPLACED
import dg.core.PhoneFrame
import dg.core.ReconnectPolicy
import dg.core.decodeBackendFrame
import dg.core.encodeFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

enum class Conn { DISCONNECTED, CONNECTING, CONNECTED, REPLACED }

/**
 * WebSocket to ws://<host>/phone. Never blocks the sensing pipeline: sends are fire-and-forget,
 * risk windows are buffered (about 30 min) while the socket is down and flushed in order.
 */
class BackendClient(
    private val scope: CoroutineScope,
    private val hello: () -> PhoneFrame.Hello,
    private val onFrame: (BackendFrame) -> Unit,
) {
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val lock = Any()
    private val pendingWindows = ArrayDeque<PhoneFrame.RiskWindow>()
    private val policy = ReconnectPolicy()
    private var ws: WebSocket? = null
    private var host = ""
    private var wanted = false
    private var tripActive = false
    private var retry: Job? = null

    private val _state = MutableStateFlow(Conn.DISCONNECTED)
    val state: StateFlow<Conn> = _state
    private val _log = MutableStateFlow<List<String>>(emptyList())
    /** Last frames in/out, newest last, for the debug screen. */
    val log: StateFlow<List<String>> = _log
    val buffered: Int get() = synchronized(lock) { pendingWindows.size }

    fun connect(host: String) {
        synchronized(lock) {
            if (wanted && host == this.host && _state.value != Conn.DISCONNECTED) return
            this.host = host
            wanted = true
        }
        open()
    }

    fun disconnect() {
        synchronized(lock) { wanted = false; retry?.cancel(); ws?.close(1000, "bye"); ws = null }
        _state.value = Conn.DISCONNECTED
    }

    private fun open() {
        val h: String
        synchronized(lock) { ws?.cancel(); h = host }
        _state.value = Conn.CONNECTING
        val req = try { Request.Builder().url("ws://$h/phone").build() } catch (e: Exception) {
            note("bad host '$h': ${e.message}"); _state.value = Conn.DISCONNECTED; return
        }
        val socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                policy.reset()
                _state.value = Conn.CONNECTED
                synchronized(lock) {
                    rawSend(webSocket, hello())
                    if (tripActive) rawSend(webSocket, PhoneFrame.TripStart) // backend lost its trip state
                    flushLocked(webSocket)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                note("← $text".take(200))
                val frame = decodeBackendFrame(text)
                onFrame(frame)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket, code)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                note("socket failure: ${t.message}"); lost(webSocket, null)
            }
        })
        synchronized(lock) { ws = socket }
    }

    private fun lost(socket: WebSocket, code: Int?) {
        synchronized(lock) {
            if (ws !== socket) return // an older socket we already replaced
            ws = null
            if (code == CLOSE_REPLACED) { wanted = false; _state.value = Conn.REPLACED; note("replaced by another phone; not reconnecting"); return }
            if (!wanted) return
        }
        _state.value = Conn.DISCONNECTED
        retry = scope.launch { delay(policy.nextDelayMs()); if (synchronized(lock) { wanted }) open() }
    }

    fun send(frame: PhoneFrame) {
        synchronized(lock) {
            when (frame) {
                is PhoneFrame.TripStart -> tripActive = true
                is PhoneFrame.TripEnd -> tripActive = false
                else -> {}
            }
            val s = ws
            if (s != null && _state.value == Conn.CONNECTED) rawSend(s, frame)
        }
    }

    fun sendWindow(w: PhoneFrame.RiskWindow) {
        synchronized(lock) {
            pendingWindows.addLast(w)
            while (pendingWindows.size > MAX_BUFFER) pendingWindows.removeFirst()
            val s = ws
            if (s != null && _state.value == Conn.CONNECTED) flushLocked(s)
        }
    }

    private fun flushLocked(s: WebSocket) {
        while (pendingWindows.isNotEmpty()) {
            if (!rawSend(s, pendingWindows.first())) return
            pendingWindows.removeFirst()
        }
    }

    private fun rawSend(s: WebSocket, f: PhoneFrame): Boolean {
        val text = encodeFrame(f)
        note("→ $text".take(200))
        return s.send(text)
    }

    private fun note(line: String) { _log.value = (_log.value + line).takeLast(12) }

    companion object { const val TAG = "BackendClient"; const val MAX_BUFFER = 180 }
}
