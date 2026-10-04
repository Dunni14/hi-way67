package dev.driverguardian.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import dev.driverguardian.sensing.PresagePreview
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import dev.driverguardian.data.AppSettings
import dev.driverguardian.net.BackendClient
import dev.driverguardian.net.Conn
import dev.driverguardian.trip.EngineStatus
import dev.driverguardian.trip.HistoryUi
import dev.driverguardian.trip.UiState
import dg.core.RiskAction
import dg.core.ServerReport
import dg.core.SharingMode
import dg.core.Verdict
import dg.core.overrideLabel
import dg.core.tierLabel

private fun tierColor(tier: Int, R: Double) = when {
    tier >= 85 || R >= 85 -> Color(0xFFE53935)
    tier >= 70 || R >= 70 -> Color(0xFFFB8C00)
    tier >= 40 || R >= 40 -> Color(0xFFFDD835)
    else -> Color(0xFF43A047)
}

@Composable
fun DashcamScreen(
    ui: UiState, conn: Conn,
    onStart: () -> Unit, onEnd: () -> Unit, onDebug: () -> Unit, onSettings: () -> Unit,
    onHistory: () -> Unit = {}, onFeedback: (Verdict) -> Unit = {},
    liveSensing: Boolean = false,
) {
    val parked = !ui.running || ui.speedMph < 3
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        CameraPreview(Modifier.fillMaxSize(), sdkOwnsCamera = liveSensing)
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.65f)))

        Row(Modifier.align(Alignment.TopStart).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            val dot = when (conn) { Conn.CONNECTED -> Color(0xFF43A047); Conn.CONNECTING -> Color(0xFFFDD835); else -> Color(0xFFE53935) }
            Box(Modifier.size(14.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.width(8.dp))
            Text(if (conn == Conn.REPLACED) "replaced" else conn.name.lowercase(), color = Color.White, fontSize = 14.sp)
            if (ui.running) {
                Spacer(Modifier.width(16.dp))
                val (label, c) = when (ui.engine.status) {
                    EngineStatus.ON -> "engine" to Color(0xFF43A047)
                    EngineStatus.STARTING -> "engine…" to Color(0xFFFDD835)
                    EngineStatus.UNAVAILABLE -> "phone scoring" to Color(0xFFFB8C00)
                    EngineStatus.OFF -> "phone scoring" to Color.Gray
                }
                Text(label, color = c, fontSize = 14.sp)
            }
        }

        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
            val color = tierColor(ui.tier, ui.R)
            Text(if (ui.calibrating) "Calibrating…" else "%.0f".format(ui.R), color = if (ui.calibrating) Color.White else color,
                fontSize = if (ui.calibrating) 48.sp else 120.sp, fontWeight = FontWeight.Bold)
            if (ui.calibrating) Text("${ui.calibrationLeftSec}s left, no alerts yet", color = Color.White)
            if (ui.running && ui.cantSeeDriver) Text("Can't see driver", color = Color(0xFFFFB74D), fontSize = 24.sp)
            if (ui.alarmOn) Text("ALARM", color = Color(0xFFE53935), fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(12.dp))
            Bar("Drowsy", ui.drowsy)
            Bar("Reckless", ui.reckless)
            EnginePanel(ui, parked, onFeedback)
        }

        Row(Modifier.align(Alignment.BottomCenter).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            // Controls only work while parked; nothing here matters while moving.
            if (ui.running) Button(onClick = onEnd, enabled = parked) { Text("End trip") }
            else Button(onClick = onStart) { Text("Start trip") }
            OutlinedButton(onClick = onSettings, enabled = parked) { Text("Settings") }
            OutlinedButton(onClick = onHistory, enabled = parked) { Text("History") }
            OutlinedButton(onClick = onDebug, enabled = parked) { Text("Debug") }
        }
    }
}

/** Engine tier, why it fired, who was told, and the false-alarm / confirmed buttons (parked only). */
@Composable
private fun EnginePanel(ui: UiState, parked: Boolean, onFeedback: (Verdict) -> Unit) {
    val e = ui.engine
    if (e.status != EngineStatus.ON || ui.calibrating) return
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(top = 12.dp)) {
        if (e.tier > 0) Text("${tierLabel(e.tier)} · ${e.override?.let(::overrideLabel) ?: e.dominant}", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        if (e.degraded) Text("Signals degraded: face not clear", color = Color(0xFFFFB74D), fontSize = 14.sp)
        if (RiskAction.NOTIFY_CONTACTS in e.actions) Text("Guardian notified", color = Color.White, fontSize = 14.sp)
        if (RiskAction.ASK_PERMISSION in e.actions) Text("Sharing is off: asking before notifying your guardian", color = Color.White, fontSize = 14.sp)
        if (e.feedbackTs != null && parked) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 8.dp)) {
                OutlinedButton(onClick = { onFeedback(Verdict.FALSE_ALARM) }) { Text("False alarm") }
                OutlinedButton(onClick = { onFeedback(Verdict.CONFIRMED) }) { Text("I was drowsy / reckless") }
            }
        }
        e.feedbackNote?.let { Text(it, color = Color.White, fontSize = 13.sp) }
    }
}

@Composable
private fun Bar(label: String, v: Double) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Color.White, modifier = Modifier.width(90.dp))
        LinearProgressIndicator(progress = { (v / 100.0).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.width(260.dp).height(10.dp))
        Text(" %.0f".format(v), color = Color.White)
    }
}

@Composable
fun CameraPreview(modifier: Modifier, sdkOwnsCamera: Boolean = false) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    AndroidView(modifier = modifier, factory = { ctx ->
        val view = PreviewView(ctx)
        if (sdkOwnsCamera) { // Presage binds the camera itself; it just needs our surface.
            PresagePreview.surface.value = view.surfaceProvider
            return@AndroidView view
        }
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_FRONT_CAMERA, preview)
            }
        }, ContextCompat.getMainExecutor(context))
        view
    })
}

@Composable
fun DebugScreen(ui: UiState, client: BackendClient, conn: Conn, onBack: () -> Unit) {
    val log by client.log.collectAsState()
    Column(Modifier.fillMaxSize().background(Color(0xFF101010)).verticalScroll(rememberScrollState()).padding(16.dp)) {
        Button(onClick = onBack) { Text("Back") }
        Mono("R=%.1f drowsy=%.1f reckless=%.1f m=%.2f dominant=%s".format(ui.R, ui.drowsy, ui.reckless, ui.m, ui.dominant))
        Mono("speed=%.0f mph  calibrating=${ui.calibrating}  cantSee=${ui.cantSeeDriver}  distracted=${ui.distracted} (not sent)".format(ui.speedMph))
        Mono("engine: ${ui.engine.status} tier=${ui.engine.tier} local R=%.1f override=${ui.engine.override} degraded=${ui.engine.degraded}".format(ui.localR))
        Mono("engine actions=${ui.engine.actions} levels=${ui.engine.levels.mapValues { "%.2f".format(it.value) }}")
        ui.engine.error?.let { Mono("engine error: $it") }
        Mono("gate: band=${ui.gateBand} held=${ui.gateHeldSec}s cooldowns(s)=${ui.cooldownSec}")
        Mono("backend: ${conn.name} buffered=${client.buffered}")
        Spacer(Modifier.height(8.dp))
        Mono("feature          x      w_drowsy (before)   w_reckless")
        for ((k, v) in ui.features) {
            val wd = ui.weightsDrowsy[k] ?: 0.0
            val wr = ui.weightsReckless[k] ?: 0.0
            val before = if (ui.nudgeDominant == dg.core.Dominant.DROWSY) ui.nudgeBefore[k] else null
            Mono("%-17s %-6s %.3f %-10s %.3f".format(k, v?.let { "%.2f".format(it) } ?: "—", wd, before?.let { "(%.3f)".format(it) } ?: "", wr))
        }
        if (ui.nudgeDominant == dg.core.Dominant.RECKLESS) Mono("last nudge applied to reckless: before=${ui.nudgeBefore.mapValues { "%.3f".format(it.value) }}")
        Spacer(Modifier.height(8.dp))
        Mono("frames:")
        log.forEach { Mono(it) }
    }
}

@Composable
private fun Mono(s: String) = Text(s, color = Color.White, fontFamily = FontFamily.Monospace, fontSize = 12.sp)

@Composable
fun SettingsScreen(s: AppSettings, onSave: (AppSettings) -> Unit, onBack: () -> Unit) {
    var host by remember(s.host) { mutableStateOf(s.host) }
    var name by remember(s.driverName) { mutableStateOf(s.driverName) }
    var sleep by remember(s.sleepHours) { mutableStateOf(s.sleepHours?.toString() ?: "") }
    Column(Modifier.fillMaxSize().background(Color(0xFF101010)).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onBack) { Text("Back") }
        OutlinedTextField(host, { host = it }, label = { Text("Backend host:port") }, singleLine = true)
        OutlinedTextField(name, { name = it }, label = { Text("Driver name") }, singleLine = true)
        Button(onClick = { onSave(s.copy(host = host, driverName = name)) }) { Text("Save host and name") }
        Text("Share state with guardian", color = Color.White)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(SharingMode.ALWAYS to "Always", SharingMode.HIGH_ONLY to "High risk only", SharingMode.NEVER to "Never").forEach { (m, label) ->
                FilterChip(selected = s.sharingMode == m, onClick = { onSave(s.copy(sharingMode = m)) }, label = { Text(label) })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = s.kidsInCar, onCheckedChange = { onSave(s.copy(kidsInCar = it)) })
            Spacer(Modifier.width(8.dp)); Text("Kids in car", color = Color.White)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = s.useEngine, onCheckedChange = { onSave(s.copy(useEngine = it)) })
            Spacer(Modifier.width(8.dp)); Text("Score on the backend risk engine (needs DATABASE_URL on the backend)", color = Color.White)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = s.lowExperience, onCheckedChange = { onSave(s.copy(lowExperience = it)) })
            Spacer(Modifier.width(8.dp)); Text("New driver (raises sensitivity)", color = Color.White)
        }
        OutlinedTextField(sleep, { sleep = it }, label = { Text("Hours slept last night (optional)") }, singleLine = true)
        Button(onClick = { onSave(s.copy(sleepHours = sleep.toDoubleOrNull())) }) { Text("Save sleep hours") }
        Text("Driver id: ${s.driverId.take(8)}…", color = Color.Gray, fontSize = 12.sp)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = s.demoMode, onCheckedChange = { onSave(s.copy(demoMode = it)) })
            Spacer(Modifier.width(8.dp)); Text("Demo mode (scripted driver signals, fake 65 mph)", color = Color.White)
        }
    }
}

private fun gradeColor(g: String) = when (g) {
    "A", "B" -> Color(0xFF43A047)
    "C" -> Color(0xFFFDD835)
    "D" -> Color(0xFFFB8C00)
    else -> Color(0xFFE53935)
}

/** Shown after "End trip", while parked. Everything comes from the windows the app held. */
@Composable
fun ReportCardScreen(card: dg.core.ReportCard, server: ServerReport?, onDone: () -> Unit) {
    Column(Modifier.fillMaxSize().background(Color(0xFF101010)).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(card.grade, color = gradeColor(card.grade), fontSize = 96.sp, fontWeight = FontWeight.Bold)
            Column {
                Text("Trip report", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text("${card.durationMin} min", color = Color.White)
            }
        }
        Text(card.advice, color = Color.White, fontSize = 16.sp)
        RiskChart(card.series, Modifier.fillMaxWidth().height(180.dp))
        Mono("avg risk %.0f   peak %.0f   time at 70+: %.0f%%".format(card.avgRisk, card.peakRisk, card.pctHighRisk))
        Mono("alerts: " + if (card.alertsByTier.isEmpty()) "none" else card.alertsByTier.entries.joinToString("  ") { "T${it.key}×${it.value}" })
        if (card.eventCounts.isNotEmpty()) Mono("events: " + card.eventCounts.entries.joinToString("  ") { "${it.key}×${it.value}" })
        server?.let { r ->
            Text("Engine grade ${r.grade}  ·  peak ${"%.0f".format(r.maxScore)}", color = gradeColor(r.grade), fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Mono("time in tier: " + (0..3).joinToString("  ") { t -> "${tierLabel(t)} ${((r.timeInTierS[t.toString()] ?: 0.0) / 60).let { "%.1f".format(it) }}m" })
            r.events.filter { it.tier > 0 }.takeLast(8).forEach { ev ->
                Mono("${ev.ts.substring(11, 19)}  ${tierLabel(ev.tier)}  ${ev.override?.let(::overrideLabel) ?: ""}  ${ev.actions.joinToString(",")}")
            }
        }
        Button(onClick = onDone) { Text("Done") }
    }
}

/** Past trips and grades from `GET /drivers/{id}/trips`. */
@Composable
fun HistoryScreen(h: HistoryUi, onRefresh: () -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().background(Color(0xFF101010)).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onBack) { Text("Back") }
            OutlinedButton(onClick = onRefresh, enabled = !h.loading) { Text(if (h.loading) "Loading…" else "Refresh") }
        }
        Text("Past trips", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        h.error?.let { Text("Could not load history: $it (is the risk engine enabled on the backend?)", color = Color(0xFFFFB74D)) }
        if (!h.loading && h.error == null && h.trips.isEmpty()) Text("No trips yet.", color = Color.White)
        h.trips.forEach { t ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(t.grade, color = gradeColor(t.grade), fontSize = 40.sp, fontWeight = FontWeight.Bold)
                Column {
                    Text(t.startedAt.replace('T', ' ').take(16), color = Color.White)
                    Mono("peak %.0f%s".format(t.maxScore, if (t.endedAt == null) "  (in progress)" else ""))
                }
            }
        }
    }
}

@Composable
private fun RiskChart(series: List<dg.core.ReportPoint>, modifier: Modifier) {
    androidx.compose.foundation.Canvas(modifier.background(Color(0xFF1A1A1A))) {
        if (series.size < 2) return@Canvas
        fun y(r: Double) = size.height * (1f - (r / 100.0).toFloat().coerceIn(0f, 1f))
        for ((level, c) in listOf(40.0 to Color(0xFFFDD835), 70.0 to Color(0xFFFB8C00), 85.0 to Color(0xFFE53935))) {
            drawLine(c.copy(alpha = 0.35f), androidx.compose.ui.geometry.Offset(0f, y(level)), androidx.compose.ui.geometry.Offset(size.width, y(level)), strokeWidth = 2f)
        }
        val path = androidx.compose.ui.graphics.Path()
        series.forEachIndexed { i, p ->
            val x = size.width * i / (series.size - 1)
            if (i == 0) path.moveTo(x, y(p.risk)) else path.lineTo(x, y(p.risk))
        }
        drawPath(path, Color.White, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f))
    }
}
