package dev.driverguardian.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import dev.driverguardian.sensing.PresagePreview
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import dev.driverguardian.trip.UiState
import dev.driverguardian.voice.VoicePlayer
import dg.core.Normalize
import dg.core.SharingMode

private fun tierColor(tier: Int, R: Double) = when {
    tier >= 85 || R >= 85 -> Color(0xFFE53935)
    tier >= 70 || R >= 70 -> Color(0xFFFB8C00)
    tier >= 40 || R >= 40 -> Color(0xFFFDD835)
    else -> Color(0xFF43A047)
}

// Wireframe palette: light gray panels with dark text over the (dimmed) camera.
private val Panel = Color(0xFFE6E6E6)
private val PanelText = Color(0xFF1E1E1E)
private val PanelLabel = Color(0xFF555555)

/** Drive tab (wireframe "Drive"): status pill, speed vs limit, trip button, four status tiles. */
@Composable
fun DashcamScreen(
    ui: UiState, conn: Conn, voice: VoicePlayer.State,
    onStart: () -> Unit, onEnd: () -> Unit,
    liveSensing: Boolean = false,
) {
    val parked = !ui.running || ui.speedMph < 3
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        // Recreate the preview when ownership flips, so the app never holds the camera Presage needs.
        key(liveSensing) { CameraPreview(Modifier.fillMaxSize(), sdkOwnsCamera = liveSensing) }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)))

        Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp)) {
            StatusPill(ui, conn, voice, Modifier.align(Alignment.CenterHorizontally))

            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Column {
                    Text(if (ui.running) "%.0f".format(ui.speedMph) else "--", color = Color.White, fontSize = 64.sp, fontWeight = FontWeight.Bold, lineHeight = 64.sp)
                    Text("current\nspeed", color = Color.White, fontSize = 13.sp, lineHeight = 15.sp)
                }
                Column(
                    Modifier.clip(RoundedCornerShape(14.dp)).background(Panel).padding(horizontal = 14.dp, vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("speed limit", color = PanelLabel, fontSize = 12.sp)
                    Text("%.0f".format(Normalize.SPEED_LIMIT_MPH), color = PanelText, fontSize = 34.sp, fontWeight = FontWeight.Bold)
                }
            }

            Spacer(Modifier.weight(1f))

            // Controls only work while parked; nothing here matters while moving.
            if (ui.running) {
                Button(onClick = onEnd, enabled = parked, modifier = Modifier.fillMaxWidth()) { Text("End trip") }
            } else {
                Button(onClick = onStart, modifier = Modifier.fillMaxWidth()) { Text("Start trip") }
            }
            Spacer(Modifier.height(10.dp))
            val tiles = statusTiles(ui, voice)
            tiles.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { t -> StatusTile(t, Modifier.weight(1f)) }
                }
            }
        }
    }
}

private data class Tile(val label: String, val value: String, val detail: String = "", val tint: Color? = null)

/** The wireframe's four tiles, filled with what the app actually measures. */
private fun statusTiles(ui: UiState, voice: VoicePlayer.State): List<Tile> {
    if (!ui.running) return listOf(Tile("attention", "--"), Tile("eye tracking", "--"), Tile("drowsiness", "--"), Tile("speech activity", "--"))
    val attention = when {
        ui.calibrating -> Tile("attention", "CALIBRATING", "${ui.calibrationLeftSec}s left")
        else -> Tile(
            "attention",
            when { ui.R >= 85 -> "DANGER"; ui.R >= 70 -> "POOR"; ui.R >= 40 -> "FAIR"; else -> "GOOD" },
            "risk %.0f".format(ui.R),
            tint = if (ui.R >= 40 || ui.tier >= 40) tierColor(ui.tier, ui.R) else null,
        )
    }
    val eyes = when {
        !ui.faceVisible -> Tile("eye tracking", "NO FACE", tint = Color(0xFFFFB74D))
        ui.liveEyeClosed == null -> Tile("eye tracking", "--")
        else -> Tile(
            "eye tracking",
            when { ui.liveEyeClosed >= 0.65 -> "CLOSED"; ui.liveEyeClosed >= 0.35 -> "HEAVY"; else -> "NORMAL" },
            "%.0f%% closed".format(ui.liveEyeClosed * 100),
        )
    }
    val drowsy = Tile(
        "drowsiness",
        when { ui.calibrating -> "--"; ui.drowsy >= 70 -> "HIGH"; ui.drowsy >= 40 -> "MEDIUM"; else -> "LOW" },
        "yawns ${ui.yawnCount}",
    )
    val speech = Tile(
        "speech activity",
        when { voice == VoicePlayer.State.LISTENING -> "LISTENING"; ui.talking == true -> "HIGH"; else -> "LOW" },
        ui.mouthOpen?.let { "mouth %.2f".format(it) } ?: "",
    )
    return listOf(attention, eyes, drowsy, speech)
}

@Composable
private fun StatusTile(t: Tile, modifier: Modifier) {
    Column(
        modifier.clip(RoundedCornerShape(10.dp)).background(t.tint ?: Panel).padding(vertical = 8.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(t.label, color = PanelLabel, fontSize = 12.sp)
        Text(t.value, color = PanelText, fontSize = 24.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(t.detail, color = PanelLabel, fontSize = 11.sp, maxLines = 1)
    }
}

/** Top pill: what the app is doing right now, most urgent first, with the backend connection dot. */
@Composable
private fun StatusPill(ui: UiState, conn: Conn, voice: VoicePlayer.State, modifier: Modifier) {
    val yawnFlash = System.currentTimeMillis() - ui.lastYawnAtMs < 4_000
    val (text, bg) = when {
        !ui.running -> "ready: tap Start trip" to Panel
        ui.alarmOn -> "PULL OVER NOW" to Color(0xFFE53935)
        voice == VoicePlayer.State.LISTENING -> "listening… say \"I'm fine\"" to Color(0xFF90CAF9)
        voice == VoicePlayer.State.SPEAKING -> "speaking…" to Color(0xFF90CAF9)
        ui.calibrating -> "calibrating · ${ui.calibrationLeftSec}s" to Panel
        !ui.faceVisible || ui.cantSeeDriver -> "can't see driver" to Color(0xFFFFB74D)
        yawnFlash -> "yawn detected" to Color(0xFFFDD835)
        else -> "driving: monitoring" to Panel
    }
    Row(
        modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val dot = when (conn) { Conn.CONNECTED -> Color(0xFF43A047); Conn.CONNECTING -> Color(0xFFFDD835); else -> Color(0xFFE53935) }
        Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.width(8.dp))
        Text(text, color = PanelText, fontSize = 13.sp)
    }
}

/** Bottom tab bar from the wireframe. Only Drive is reachable while moving. */
@Composable
fun TabBar(selected: String, parked: Boolean, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Color(0xFFD6D6D6)).navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (tab in listOf("drive", "stats", "contacts", "settings")) {
            val on = tab == selected
            val enabled = on || tab == "drive" || parked
            Box(
                Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(6.dp))
                    .background(if (on) Color(0xFF555555) else Color(0xFF9E9E9E).copy(alpha = if (enabled) 1f else 0.4f))
                    .clickable(enabled = enabled) { onSelect(tab) },
                contentAlignment = Alignment.Center,
            ) { Text(tab, color = if (on) Color.White else PanelText, fontSize = 13.sp) }
        }
    }
}

/** Simple message screen for tabs that have nothing to show yet. */
@Composable
fun PlaceholderScreen(title: String, body: String) {
    Column(Modifier.fillMaxSize().background(Color.White).statusBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, color = PanelText, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text(body, color = PanelLabel, fontSize = 15.sp)
    }
}

@Composable
fun CameraPreview(modifier: Modifier, sdkOwnsCamera: Boolean = false) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    AndroidView(modifier = modifier, factory = { ctx ->
        val view = PreviewView(ctx)
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            if (sdkOwnsCamera) {
                // Presage binds the camera itself and only needs our surface. Release anything the
                // preview bound earlier (e.g. while demo mode was on) so the SDK can open the camera.
                provider.unbindAll()
                PresagePreview.surface.value = view.surfaceProvider
                return@addListener
            }
            PresagePreview.surface.value = null
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_FRONT_CAMERA, preview)
            }
        }, ContextCompat.getMainExecutor(context))
        view
    }, onRelease = { view ->
        // Don't let the SDK pick up a surface from a view that's gone.
        if (PresagePreview.surface.value === view.surfaceProvider) PresagePreview.surface.value = null
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
        Mono("face: visible=${ui.faceVisible} eyeClosed=${ui.liveEyeClosed?.let { "%.2f".format(it) } ?: "—"} " +
            "mouth=${ui.mouthOpen?.let { "%.2f".format(it) } ?: "—"} (yawn ≥ %.2f) talking=${ui.talking} yawns=${ui.yawnCount}".format(dg.core.FaceGeometry.MAR_YAWN))
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
fun SettingsScreen(s: AppSettings, onSave: (AppSettings) -> Unit, onDebug: () -> Unit) {
    var host by remember(s.host) { mutableStateOf(s.host) }
    var name by remember(s.driverName) { mutableStateOf(s.driverName) }
    Column(Modifier.fillMaxSize().background(Color(0xFF101010)).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Settings", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        OutlinedTextField(host, { host = it }, label = { Text("Backend host:port") }, singleLine = true)
        OutlinedTextField(name, { name = it }, label = { Text("Driver name") }, singleLine = true)
        Button(onClick = { onSave(s.copy(host = host, driverName = name)) }) { Text("Save host and name") }
        Text("Share state with guardian", color = Color.White)
        Column {
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
        OutlinedButton(onClick = onDebug) { Text("Debug: features, weights, face values") }
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
fun ReportCardScreen(card: dg.core.ReportCard, onDone: () -> Unit) {
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
        Button(onClick = onDone) { Text("Done") }
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
