package dev.driverguardian.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
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
import dev.driverguardian.trip.UiState
import dg.core.SharingMode
import dg.core.TripReport

private fun tierColor(tier: Int, R: Double) = when {
    tier >= 85 || R >= 85 -> Color(0xFFE53935)
    tier >= 70 || R >= 70 -> Color(0xFFFB8C00)
    tier >= 40 || R >= 40 -> Color(0xFFFDD835)
    else -> Color(0xFF43A047)
}

@Composable
fun DashcamScreen(
    ui: UiState, conn: Conn, settings: AppSettings, onSave: (AppSettings) -> Unit,
    onStart: () -> Unit, onEnd: () -> Unit, onDebug: () -> Unit, onSettings: () -> Unit,
) {
    val parked = !ui.running || ui.speedMph < 3
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        CameraPreview(Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.65f)))

        Row(Modifier.align(Alignment.TopStart).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            val dot = when (conn) { Conn.CONNECTED -> Color(0xFF43A047); Conn.CONNECTING -> Color(0xFFFDD835); else -> Color(0xFFE53935) }
            Box(Modifier.size(14.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.width(8.dp))
            Text(if (conn == Conn.REPLACED) "replaced" else conn.name.lowercase(), color = Color.White, fontSize = 14.sp)
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
        }

        if (!ui.running) {
            // Trip-start context toggles. The multiplier shows how much they raise the stakes of existing risk.
            Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Before you drive", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                ToggleRow("Kids in car", settings.kidsInCar) { onSave(settings.copy(kidsInCar = it)) }
                ToggleRow("Low driving experience", settings.lowExperience) { onSave(settings.copy(lowExperience = it)) }
                Text("Risk multiplier ×%.2f".format(ui.contextM), color = Color(0xFFFFB74D), fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
        }

        Row(Modifier.align(Alignment.BottomCenter).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            // Controls only work while parked; nothing here matters while moving.
            if (ui.running) Button(onClick = onEnd, enabled = parked) { Text("End trip") }
            else Button(onClick = onStart) { Text("Start trip") }
            OutlinedButton(onClick = onSettings, enabled = parked) { Text("Settings") }
            OutlinedButton(onClick = onDebug, enabled = parked) { Text("Debug") }
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Switch(checked = checked, onCheckedChange = onChange)
        Spacer(Modifier.width(8.dp)); Text(label, color = Color.White)
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
fun CameraPreview(modifier: Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    AndroidView(modifier = modifier, factory = { ctx ->
        val view = PreviewView(ctx)
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
            Switch(checked = s.demoMode, onCheckedChange = { onSave(s.copy(demoMode = it)) })
            Spacer(Modifier.width(8.dp)); Text("Demo mode (scripted driver signals, fake 65 mph)", color = Color.White)
        }
    }
}

@Composable
fun ReportScreen(r: TripReport, onDone: () -> Unit) {
    val gradeColor = when (r.grade) { "A" -> Color(0xFF43A047); "B" -> Color(0xFF9CCC65); "C" -> Color(0xFFFDD835); "D" -> Color(0xFFFB8C00); else -> Color(0xFFE53935) }
    Column(Modifier.fillMaxSize().background(Color(0xFF101010)).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(r.grade, color = gradeColor, fontSize = 96.sp, fontWeight = FontWeight.Bold)
            Column {
                Text("Trip report", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text("%d min, avg risk %.0f, peak %.0f".format(r.durationSec / 60, r.avgR, r.peakR), color = Color.White)
            }
        }
        Text(r.advice, color = Color.White, fontSize = 18.sp)
        Text("Risk over time", color = Color.White)
        RiskChart(r.points.map { it.R }, Modifier.fillMaxWidth().height(160.dp))
        Text("Hard brakes ${r.hardBrakes}   Swerves ${r.swerves}   Yawns ${r.yawns}   Nods ${r.nods}", color = Color.White)
        Text("%.0f%% of the trip at high risk (70+)".format(r.highRiskShare * 100), color = Color.White)
        Button(onClick = onDone) { Text("Done") }
    }
}

@Composable
private fun RiskChart(values: List<Double>, modifier: Modifier) {
    Canvas(modifier.background(Color(0xFF1A1A1A))) {
        fun y(v: Double) = size.height * (1f - (v / 100.0).toFloat().coerceIn(0f, 1f))
        for ((level, c) in listOf(40.0 to Color(0xFFFDD835), 70.0 to Color(0xFFFB8C00), 85.0 to Color(0xFFE53935))) {
            drawLine(c.copy(alpha = 0.4f), Offset(0f, y(level)), Offset(size.width, y(level)), strokeWidth = 1f)
        }
        if (values.size < 2) return@Canvas
        val step = size.width / (values.size - 1)
        val path = Path().apply {
            values.forEachIndexed { i, v -> if (i == 0) moveTo(0f, y(v)) else lineTo(i * step, y(v)) }
        }
        drawPath(path, Color(0xFF64B5F6), style = Stroke(width = 4f))
    }
}
