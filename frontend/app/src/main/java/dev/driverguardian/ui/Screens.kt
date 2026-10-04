package dev.driverguardian.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import dev.driverguardian.sensing.PresagePreview
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import dev.driverguardian.R
import dev.driverguardian.data.AppSettings
import dev.driverguardian.net.BackendClient
import dev.driverguardian.net.Conn
import dev.driverguardian.trip.UiState
import dev.driverguardian.voice.VoicePlayer
import dg.core.SPEED_LIMIT_MPH
import dg.core.SharingMode
import kotlinx.coroutines.launch

/** Why the risk engine raised the tier, in plain words. */
private fun overrideText(o: String?) = when (o) {
    "microsleep" -> "eyes closed too long"
    "drowsy_sustained_3", "drowsy_sustained_12" -> "drowsy for a while"
    "tier2_sustained_12" -> "warning ignored"
    null -> null
    else -> o
}

/** Drive tab (Figma "Drive"): status pill, speed vs limit, camera card with the trip button, four status tiles. */
@Composable
fun DashcamScreen(
    ui: UiState, conn: Conn, voice: VoicePlayer.State,
    onStart: () -> Unit, onEnd: () -> Unit,
    liveSensing: Boolean = false,
    driverName: String = "",
) {
    Column(Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().padding(start = 15.dp, end = 15.dp, top = 8.dp, bottom = 14.dp)) {
        StatusPill(ui, conn, voice, driverName, Modifier.align(Alignment.CenterHorizontally))

        Row(
            Modifier.fillMaxWidth().padding(start = 24.dp, end = 4.dp, top = 4.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (ui.running) "%.0f".format(ui.speedMph) else "--", color = Good, fontSize = 45.sp, fontWeight = FontWeight.Medium, lineHeight = 52.sp)
                Text("current\nspeed", color = SystemText, style = Label, textAlign = TextAlign.Center)
            }
            Column(
                Modifier.size(85.dp, 86.dp).card(color = Surface, elevation = 3.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Text("%.0f".format(SPEED_LIMIT_MPH), color = SystemText, fontSize = 32.sp, fontWeight = FontWeight.Medium, lineHeight = 34.sp)
                Text("speed\nlimit", color = SystemText, style = Label, textAlign = TextAlign.Center)
            }
        }

        // The card shows the 3D map; the driver camera is a small picture-in-picture in the corner.
        Box(Modifier.fillMaxWidth().weight(1f).card(color = Pressed)) {
            DriveMapView(Modifier.fillMaxSize())
            Box(Modifier.align(Alignment.TopEnd).padding(10.dp).size(72.dp, 96.dp).card(RoundedCornerShape(14.dp), Color.Black, 4.dp)) {
                // Recreate the preview when ownership flips, so the app never holds the camera Presage needs.
                key(liveSensing) { CameraPreview(Modifier.fillMaxSize(), sdkOwnsCamera = liveSensing) }
            }
            val button = Modifier.align(Alignment.BottomCenter).padding(12.dp).fillMaxWidth()
            if (ui.running) {
                HoldButton("Hold to end trip", button, onHeld = onEnd)
            } else {
                Button(
                    onClick = onStart, modifier = button.height(52.dp), shape = CardShape,
                    colors = ButtonDefaults.buttonColors(containerColor = Main),
                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 4.dp),
                ) { Text("Start trip", fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }
            }
        }

        statusTiles(ui, voice).chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                row.forEach { t -> StatusTile(t, Modifier.weight(1f)) }
            }
        }
    }
}

/** Fires [onHeld] only after a continuous hold, so a stray touch while driving can't end the trip. */
@Composable
private fun HoldButton(text: String, modifier: Modifier, holdMs: Int = 1500, onHeld: () -> Unit) {
    val progress = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val held by rememberUpdatedState(onHeld)
    Box(
        modifier.height(52.dp).card(color = Main, elevation = 4.dp)
            .drawBehind { drawRect(Bad, size = Size(size.width * progress.value, size.height)) }
            .pointerInput(Unit) {
                detectTapGestures(onPress = {
                    val fill = scope.launch {
                        progress.animateTo(1f, tween(holdMs, easing = LinearEasing))
                        held()
                    }
                    tryAwaitRelease()
                    fill.cancel()
                    progress.snapTo(0f)
                })
            },
        contentAlignment = Alignment.Center,
    ) { Text(text, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }
}

/** The design's three tile states: green value, blue value, red tile. NONE is "no reading yet". */
private enum class Level { GREAT, GOOD, BAD, NONE }

private data class Tile(val label: String, val icon: Int?, val value: String, val detail: String = "", val level: Level = Level.NONE)

/** The design's four tiles, filled with what the app actually measures (drowsiness in place of distraction). */
private fun statusTiles(ui: UiState, voice: VoicePlayer.State): List<Tile> {
    val eye = R.drawable.ic_attention
    val focus = R.drawable.ic_eye_tracking
    val mic = R.drawable.ic_mic
    if (!ui.running) return listOf(Tile("Attention", eye, "--"), Tile("Drowsiness", null, "--"), Tile("Eye Tracking", focus, "--"), Tile("Speech", mic, "--"))
    val attention = when {
        ui.calibrating -> Tile("Attention", eye, "--", "calibrating ${ui.calibrationLeftSec}s")
        else -> Tile(
            "Attention", eye,
            when (ui.tier) { 3 -> "DANGER"; 2 -> "POOR"; 1 -> "FAIR"; else -> "GOOD" },
            overrideText(ui.override) ?: "risk %.0f".format(ui.score),
            when { ui.tier >= 2 -> Level.BAD; ui.tier == 1 -> Level.GOOD; else -> Level.GREAT },
        )
    }
    // The risk engine's drowsy level (0..1); 0.6 held for 3 windows is its tier 2 trigger.
    val drowsyLevel = ui.levels["drowsy"] ?: 0.0
    val drowsy = when {
        ui.calibrating -> Tile("Drowsiness", null, "--", "yawns ${ui.yawnCount}")
        else -> Tile(
            "Drowsiness", null,
            when { drowsyLevel >= 0.6 -> "HIGH"; drowsyLevel >= 0.3 -> "MEDIUM"; else -> "LOW" },
            "yawns ${ui.yawnCount}",
            when { drowsyLevel >= 0.6 -> Level.BAD; drowsyLevel >= 0.3 -> Level.GOOD; else -> Level.GREAT },
        )
    }
    val eyes = when {
        !ui.faceVisible -> Tile("Eye Tracking", focus, "NO FACE", level = Level.BAD)
        ui.liveEyeClosed == null -> Tile("Eye Tracking", focus, "--")
        else -> Tile(
            "Eye Tracking", focus,
            when { ui.liveEyeClosed >= 0.65 -> "CLOSED"; ui.liveEyeClosed >= 0.35 -> "HEAVY"; else -> "NORMAL" },
            "%.0f%% closed".format(ui.liveEyeClosed * 100),
            when { ui.liveEyeClosed >= 0.65 -> Level.BAD; ui.liveEyeClosed >= 0.35 -> Level.GOOD; else -> Level.GREAT },
        )
    }
    val listening = voice == VoicePlayer.State.LISTENING
    val speech = Tile(
        "Speech", mic,
        when { listening -> "LISTENING"; ui.talking == true -> "HIGH"; else -> "LOW" },
        ui.mouthOpen?.let { "mouth %.2f".format(it) } ?: "",
        if (listening || ui.talking == true) Level.GOOD else Level.GREAT,
    )
    return listOf(attention, drowsy, eyes, speech)
}

@Composable
private fun StatusTile(t: Tile, modifier: Modifier) {
    val bad = t.level == Level.BAD
    val valueColor = when (t.level) { Level.GREAT -> Good; Level.GOOD -> Main; Level.BAD -> Surface; Level.NONE -> SystemText }
    Row(
        modifier.height(86.dp).card(color = if (bad) Bad else Color.White, elevation = if (bad) 8.dp else 5.dp).padding(start = 18.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tint = if (bad) Color.White else Main
        Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
            if (t.icon != null) {
                Icon(painterResource(t.icon), contentDescription = null, tint = tint, modifier = Modifier.fillMaxSize())
            } else {
                // The design has no drowsiness icon; a moon in the same weight as the others.
                Icon(Icons.Rounded.Bedtime, contentDescription = null, tint = tint, modifier = Modifier.fillMaxSize())
            }
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text(t.label, color = if (bad) Pressed else SystemText, style = Label, maxLines = 1)
            // 24 sp is the design size; longer words than the design's shrink to stay on one line.
            val size = when { t.value.length <= 5 -> 24.sp; t.value.length == 6 -> 20.sp; else -> 15.sp }
            Text(t.value, color = valueColor, fontSize = size, fontWeight = FontWeight.Bold, lineHeight = 26.sp, maxLines = 1, softWrap = false)
            if (t.detail.isNotEmpty()) Text(t.detail, color = if (bad) Pressed else SystemText, fontSize = 11.sp, lineHeight = 13.sp, maxLines = 1)
        }
    }
}

/**
 * Top pill (Figma): the driver's avatar overlapping a white pill that says what the app is doing, most
 * urgent first. The avatar ring is the backend connection: green connected, yellow connecting, red down.
 */
@Composable
private fun StatusPill(ui: UiState, conn: Conn, voice: VoicePlayer.State, driverName: String, modifier: Modifier) {
    val yawnFlash = System.currentTimeMillis() - ui.lastYawnAtMs < 4_000
    val (text, bg) = when {
        !ui.running -> "Ready • Tap Start trip" to TabBg
        ui.alarmOn -> "PULL OVER NOW" to Bad
        voice == VoicePlayer.State.LISTENING -> "Listening… say \"I'm fine\"" to Pressed
        voice == VoicePlayer.State.SPEAKING -> "Speaking…" to Pressed
        ui.calibrating -> "Calibrating • ${ui.calibrationLeftSec}s" to TabBg
        !ui.faceVisible || ui.cantSeeDriver -> "Can't see driver" to Warn
        yawnFlash -> "Yawn detected" to Color(0xFFFDD835)
        else -> "Driving • Monitoring" to TabBg
    }
    val ring = when (conn) { Conn.CONNECTED -> Good; Conn.CONNECTING -> Color(0xFFFDD835); else -> Bad }
    Box(modifier.height(44.dp), contentAlignment = Alignment.CenterStart) {
        Box(
            Modifier.padding(start = 22.dp).height(34.dp).widthIn(min = 210.dp).card(RoundedCornerShape(50), bg, 4.dp)
                .padding(start = 32.dp, end = 18.dp),
            contentAlignment = Alignment.Center,
        ) { Text(text, color = if (bg == Bad) Surface else SystemText, style = Label) }
        Box(
            Modifier.size(44.dp).shadow(6.dp, CircleShape).clip(CircleShape).background(ring).padding(3.dp)
                .clip(CircleShape).background(Main),
            contentAlignment = Alignment.Center,
        ) {
            Text(driverName.trim().take(1).uppercase().ifEmpty { "•" }, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

private val Tabs = listOf(
    "drive" to R.drawable.ic_drive, "stats" to R.drawable.ic_statistics,
    "contacts" to R.drawable.ic_groups, "settings" to R.drawable.ic_settings,
)

/** Bottom tab bar from the design. Only Drive is reachable while moving. */
@Composable
fun TabBar(selected: String, parked: Boolean, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().shadow(12.dp, RectangleShape, ambientColor = Main.copy(alpha = 0.1f), spotColor = Main.copy(alpha = 0.1f))
            .background(TabBg).navigationBarsPadding().padding(start = 15.dp, end = 15.dp, top = 8.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for ((tab, icon) in Tabs) {
            val on = tab == selected
            val enabled = on || tab == "drive" || parked
            val color = (if (on) Main else SystemText).copy(alpha = if (enabled) 1f else 0.35f)
            Column(
                Modifier.weight(1f).height(66.dp).clip(CardShape).background(if (on) Pressed else Color.Transparent)
                    .clickable(enabled = enabled) { onSelect(tab) },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(28.dp))
                Spacer(Modifier.height(4.dp))
                Text(tab.replaceFirstChar { it.uppercase() }, color = color, style = Label, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** Simple message screen for tabs that have nothing to show yet, titled like the Contacts wireframe. */
@Composable
fun PlaceholderScreen(title: String, body: String) {
    Column(Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().padding(horizontal = 18.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(title, style = ScreenTitle, modifier = Modifier.padding(start = 4.dp, top = 12.dp))
        Text(body, color = SystemText, fontSize = 15.sp, lineHeight = 21.sp, modifier = Modifier.fillMaxWidth().card().padding(18.dp))
    }
}

@Composable
fun CameraPreview(modifier: Modifier, sdkOwnsCamera: Boolean = false) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    AndroidView(modifier = modifier, factory = { ctx ->
        // TextureView mode: the default SurfaceView draws outside the rounded card and punches through
        // whatever is drawn above it.
        val view = PreviewView(ctx).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
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
        Mono("risk engine (backend): tier ${ui.tier}  score %.1f  dominant ${ui.dominant}".format(ui.score))
        Mono("override=${ui.override ?: "—"}  degraded=${ui.degraded}  calibrating=${ui.calibrating}  actions=${ui.lastActions}")
        Mono("levels (0..1):")
        for ((k, v) in ui.levels) Mono("  %-11s %.2f".format(k, v))
        Mono("\"I'm fine\" feedback: " + (ui.feedbackFactor?.let { "%s weight x%.2f for this driver".format(it, ui.feedbackMultiplier ?: 1.0) } ?: "none yet"))
        Spacer(Modifier.height(8.dp))
        Mono("last window sent (#${ui.windowsSent}), speed=%.0f mph:".format(ui.speedMph))
        ui.lastSignals?.let { s ->
            Mono("  face=${s.faceVisible} eyesClosed=${s.eyeClosureFrac?.let { "%.2f".format(it) } ?: "—"} longestClosure=${s.longestEyeClosureS?.let { "%.1fs".format(it) } ?: "—"}")
            Mono("  yawns=${s.yawns} hr=${s.heartRate?.let { "%.0f".format(it) } ?: "—"} br=${s.breathingRate?.let { "%.1f".format(it) } ?: "—"} stress=${s.emotionStress?.let { "%.2f".format(it) } ?: "—"} brakes=${s.hardBrakes} swerves=${s.swerves}")
        }
        Mono("face now: visible=${ui.faceVisible} eyeClosed=${ui.liveEyeClosed?.let { "%.2f".format(it) } ?: "—"} " +
            "mouth=${ui.mouthOpen?.let { "%.2f".format(it) } ?: "—"} (yawn ≥ %.2f) talking=${ui.talking} yawns=${ui.yawnCount}".format(dg.core.FaceGeometry.MAR_YAWN))
        Mono("backend: ${conn.name} buffered=${client.buffered}")
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
    val field = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = Main, unfocusedBorderColor = Hairline, focusedLabelColor = Main,
        unfocusedContainerColor = Surface, focusedContainerColor = Color.White,
    )
    Column(
        Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Settings", style = ScreenTitle, modifier = Modifier.padding(start = 4.dp, top = 12.dp))

        SettingsGroup("Driver") {
            OutlinedTextField(name, { name = it }, label = { Text("Driver name") }, singleLine = true, shape = RoundedCornerShape(14.dp), colors = field, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(host, { host = it }, label = { Text("Backend host:port") }, singleLine = true, shape = RoundedCornerShape(14.dp), colors = field, modifier = Modifier.fillMaxWidth())
            Button(
                onClick = { onSave(s.copy(host = host, driverName = name)) }, modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(14.dp), colors = ButtonDefaults.buttonColors(containerColor = Main),
            ) { Text("Save host and name", fontWeight = FontWeight.SemiBold) }
        }

        SettingsGroup("Share state with guardian") {
            // Segmented control: the selected option sits on the same pale-blue pill as the selected tab.
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Surface).border(1.dp, Hairline, RoundedCornerShape(14.dp)).padding(4.dp)) {
                listOf(SharingMode.ALWAYS to "Always", SharingMode.HIGH_ONLY to "High risk", SharingMode.NEVER to "Never").forEach { (m, label) ->
                    val on = s.sharingMode == m
                    Box(
                        Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(11.dp)).background(if (on) Pressed else Color.Transparent)
                            .clickable { onSave(s.copy(sharingMode = m)) },
                        contentAlignment = Alignment.Center,
                    ) { Text(label, color = if (on) Main else SystemText, fontSize = 14.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium) }
                }
            }
        }

        SettingsGroup("Trip") {
            ToggleRow("Kids in car", "Alerts start one level higher", s.kidsInCar) { onSave(s.copy(kidsInCar = it)) }
            HorizontalDivider(color = Hairline)
            ToggleRow("Demo mode", "Scripted driver signals, fake 65 mph", s.demoMode) { onSave(s.copy(demoMode = it)) }
        }

        Row(
            Modifier.fillMaxWidth().card().clickable(onClick = onDebug).padding(horizontal = 18.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Debug", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("Features, weights, face values", color = Muted, fontSize = 13.sp)
            }
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = Muted)
        }
    }
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().card().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = SectionTitleStyle, fontSize = 17.sp)
        content()
    }
}

@Composable
private fun ToggleRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(detail, color = Muted, fontSize = 13.sp)
        }
        Switch(
            checked = checked, onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = Main, uncheckedTrackColor = Pressed, uncheckedBorderColor = Hairline, uncheckedThumbColor = SystemText),
        )
    }
}

private fun gradeColor(g: String) = when (g) {
    "A", "B" -> Good
    "C" -> Warn
    "D" -> Color(0xFFFB8C00)
    else -> Bad
}

/** Shown after "End trip", while parked. Everything comes from the windows the app held. */
@Composable
fun ReportCardScreen(card: dg.core.ReportCard, onDone: () -> Unit) {
    Column(
        Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth().card().padding(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            val tint = gradeColor(card.grade)
            Box(Modifier.size(96.dp).clip(CircleShape).background(tint.copy(alpha = 0.12f)).border(6.dp, tint, CircleShape), contentAlignment = Alignment.Center) {
                Text(card.grade, color = tint, fontSize = 48.sp, fontWeight = FontWeight.Bold)
            }
            Column {
                Text("Trip report", style = SectionTitleStyle, fontSize = 22.sp)
                Text("${card.durationMin} min", color = Muted, fontSize = 14.sp)
            }
        }
        Text(card.advice, color = Ink, fontSize = 16.sp, lineHeight = 22.sp, modifier = Modifier.fillMaxWidth().card().padding(18.dp))
        Column(Modifier.fillMaxWidth().card().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Risk over time", style = SectionTitleStyle, fontSize = 17.sp)
            RiskChart(card.series, Modifier.fillMaxWidth().height(170.dp))
            ReportFact("Average risk", "%.0f".format(card.avgRisk))
            ReportFact("Peak risk", "%.0f".format(card.peakRisk))
            ReportFact("Time at warning or worse", "%.0f%%".format(card.pctHighRisk))
            ReportFact("Alerts", if (card.alertsByTier.isEmpty()) "none" else card.alertsByTier.entries.joinToString("  ") { "T${it.key}×${it.value}" })
            if (card.eventCounts.isNotEmpty()) ReportFact("Events", card.eventCounts.entries.joinToString("  ") { "${it.key}×${it.value}" })
        }
        Button(
            onClick = onDone, modifier = Modifier.fillMaxWidth().height(52.dp), shape = CardShape,
            colors = ButtonDefaults.buttonColors(containerColor = Main),
        ) { Text("Done", fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }
    }
}

@Composable
private fun ReportFact(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, color = SystemText, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text(value, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun RiskChart(series: List<dg.core.ReportPoint>, modifier: Modifier) {
    androidx.compose.foundation.Canvas(modifier.clip(RoundedCornerShape(12.dp)).background(Surface)) {
        if (series.size < 2) return@Canvas
        fun y(r: Double) = size.height * (1f - (r / 100.0).toFloat().coerceIn(0f, 1f))
        for ((level, c) in listOf(40.0 to Warn, 70.0 to Color(0xFFFB8C00), 85.0 to Bad)) {
            drawLine(c.copy(alpha = 0.35f), androidx.compose.ui.geometry.Offset(0f, y(level)), androidx.compose.ui.geometry.Offset(size.width, y(level)), strokeWidth = 2f)
        }
        val path = androidx.compose.ui.graphics.Path()
        series.forEachIndexed { i, p ->
            val x = size.width * i / (series.size - 1)
            if (i == 0) path.moveTo(x, y(p.risk)) else path.lineTo(x, y(p.risk))
        }
        drawPath(path, Main, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 5f, cap = androidx.compose.ui.graphics.StrokeCap.Round))
    }
}
