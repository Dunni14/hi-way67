package dev.driverguardian.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.AddRoad
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.DirectionsCar
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Lightbulb
import androidx.compose.material.icons.rounded.Snooze
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.driverguardian.R
import dev.driverguardian.net.HistoryApi
import dg.core.DailyStat
import dg.core.DriverStats

/**
 * Stats tab (Figma "Driving · Stats", docs/design/figma/stats-screen.png): the last 7 days of the driver's
 * report cards from the backend (GET /drivers/{id}/stats, Tiger Data), with Trip history as a submenu.
 * Only metrics the system actually measures are shown; no week-over-week deltas (raw history is kept 7 days).
 */
@Composable
fun StatsDashboard(api: HistoryApi, driverHint: String, onOpenLastReport: (() -> Unit)?) {
    var page by remember { mutableStateOf("dash") }
    var stats by remember { mutableStateOf<DriverStats?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }

    if (page == "history") {
        TripHistoryScreen(api, driverHint, onOpenLastReport, onBack = { page = "dash" })
        return
    }

    LaunchedEffect(reload) {
        error = null
        loading = true
        runCatching {
            val name = api.driverName() ?: driverHint.ifBlank { null } ?: error("no driver name")
            api.stats(name)
        }.onSuccess { stats = it }.onFailure { error = it.message ?: "couldn't reach the backend" }
        loading = false
    }

    Column(
        Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        HeaderPill(Modifier.align(Alignment.CenterHorizontally))
        val s = stats
        when {
            error != null -> Section { Text("Couldn't load stats: $error. Is the backend running and the host in Settings right?", color = SystemText, fontSize = 14.sp) }
            s == null -> Throbber("Loading this week's stats")
            else -> {
                ScoreCard(s)
                Section("Weekly trends", "Safety score (last ${s.days} days)") { WeekChart(s.daily) }
                Section("Behavior insights", "From the risk engine's analysis of your drives") {
                    TileRow(
                        { Tile(it, painterResource(R.drawable.ic_attention), "Attention", s.attention.value ?: "--", ratingColor(s.attention.value),
                            s.attention.calmShare?.let { c -> "calm %.0f%% of the time".format(c * 100) }) },
                        { Tile(it, painterResource(R.drawable.ic_eye_tracking), "Eye tracking", s.eyeTracking.value ?: "--", ratingColor(s.eyeTracking.value),
                            if (s.eyeTracking.microsleeps > 0) "%.0f microsleeps".format(s.eyeTracking.microsleeps) else "longest %.1f s".format(s.eyeTracking.longestClosureS)) },
                    )
                }
                Section("Driving patterns", "Key driving metrics from this week") {
                    TileRow(
                        { Tile(it, rememberVectorPainter(Icons.Rounded.Speed), "Average speed", s.avgSpeedMph?.let { v -> "%.0f mph".format(v) } ?: "--") },
                        { Tile(it, rememberVectorPainter(Icons.Rounded.DirectionsCar), "Harsh braking", "%.0f".format(s.hardBrakes), tint = Bad, badge = BadTint) },
                    )
                    TileRow(
                        { Tile(it, rememberVectorPainter(Icons.Rounded.DarkMode), "Night driving", s.nightShare?.let { v -> "%.0f%%".format(v * 100) } ?: "--") },
                        { Tile(it, rememberVectorPainter(Icons.Rounded.AddRoad), "Distance", "%.1f mi".format(s.distanceMi)) },
                    )
                    TileRow(
                        { Tile(it, rememberVectorPainter(Icons.Rounded.Snooze), "Yawns", "%.0f".format(s.yawns)) },
                        { Tile(it, rememberVectorPainter(Icons.Rounded.VisibilityOff), "Microsleeps", "%.0f".format(s.eyeTracking.microsleeps),
                            tint = if (s.eyeTracking.microsleeps > 0) Bad else Main, badge = if (s.eyeTracking.microsleeps > 0) BadTint else Pressed) },
                    )
                }
                if (s.tips.isNotEmpty()) {
                    Section("Recommendations", "Based on this week's drives") {
                        s.tips.forEach { t -> TipRow(t.title, t.detail) }
                    }
                }
            }
        }
        NavRow(Icons.Rounded.History, "Trip history", "Every stored trip and its report card") { page = "history" }
        onOpenLastReport?.let { NavRow(Icons.Rounded.Description, "Last trip's report card", "The card shown when your last trip ended", it) }
        BusyTextButton("Refresh", busy = loading && stats != null, modifier = Modifier.align(Alignment.CenterHorizontally)) { reload++ }
    }
}

private fun ratingColor(v: String?) = when (v) {
    null, "--" -> SystemText
    "GREAT" -> Good
    "GOOD", "NORMAL" -> Main
    else -> Bad
}

/** "Driving · Stats" pill at the top, as in the mockup. */
@Composable
private fun HeaderPill(modifier: Modifier) {
    Row(
        modifier.height(46.dp).card(RoundedCornerShape(50), elevation = 4.dp).padding(horizontal = 22.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(painterResource(R.drawable.ic_drive), contentDescription = null, tint = Main, modifier = Modifier.size(22.dp))
        Text("Driving · Stats", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Medium)
    }
}

/** Score ring, headline and the three counts. One row on wide phones (as in the mockup), two rows otherwise. */
@Composable
private fun ScoreCard(s: DriverStats) {
    val score = s.safetyScore
    val blurb = when {
        score == null -> "No trips this week yet."
        score >= 85 -> "Great driving this week!"
        score >= 70 -> "Mostly safe driving this week."
        else -> "Some risky drives this week."
    }
    BoxWithConstraints(Modifier.fillMaxWidth().card().padding(horizontal = 16.dp, vertical = 18.dp)) {
        val wide = maxWidth >= 380.dp
        val headline = @Composable { m: Modifier ->
            Row(m, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                ScoreRing(score, Modifier.size(if (wide) 92.dp else 100.dp))
                Column {
                    Text("Driving\nSafety Score", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
                    Spacer(Modifier.height(4.dp))
                    Text(blurb, color = Muted, fontSize = 13.sp)
                }
            }
        }
        val counts = @Composable { m: Modifier ->
            Row(m.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                VDivider()
                Count(Modifier.weight(1f), Icons.Rounded.DirectionsCar, SystemText, Pressed, "${s.trips}", "Trips")
                VDivider()
                Count(Modifier.weight(1f), Icons.Rounded.VerifiedUser, Good, GoodTint, "${s.safeTrips}", "Safe trips")
                VDivider()
                Count(Modifier.weight(1f), Icons.Rounded.Warning, Bad, BadTint, "${s.riskEvents}", "Risk events")
            }
        }
        if (wide) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                headline(Modifier.weight(1.15f))
                counts(Modifier.weight(1f))
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                headline(Modifier)
                counts(Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun VDivider() = Box(Modifier.width(1.dp).fillMaxHeight().padding(vertical = 4.dp).background(Hairline))

@Composable
private fun ScoreRing(score: Double?, modifier: Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 11.dp.toPx()
            val inset = stroke / 2
            val arc = Size(size.width - stroke, size.height - stroke)
            drawArc(Pressed, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
            if (score != null) drawArc(Main, -90f, (score / 100.0 * 360).toFloat(), false, Offset(inset, inset), arc, style = Stroke(stroke, cap = StrokeCap.Round))
        }
        Text(score?.let { "%.0f".format(it) } ?: "--", color = Ink, fontSize = 34.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Count(modifier: Modifier, icon: ImageVector, tint: Color, bg: Color, value: String, label: String) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        IconBadge(icon, tint, bg, 34.dp)
        Spacer(Modifier.height(4.dp))
        Text(value, color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Bold, lineHeight = 22.sp)
        Text(label, color = Muted, fontSize = 12.sp, maxLines = 1)
    }
}

/** Safety score per day: 0–100 axis with dashed gridlines, gradient bars, the best day in a deeper blue. */
@Composable
private fun WeekChart(days: List<DailyStat>) {
    val measurer = rememberTextMeasurer()
    val axis = TextStyle(fontFamily = Inter, color = Muted, fontSize = 11.sp)
    val value = TextStyle(fontFamily = Inter, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    val best = days.mapNotNull { it.score }.maxOrNull()
    Canvas(Modifier.fillMaxWidth().height(170.dp).padding(top = 4.dp)) {
        val axisW = 30.dp.toPx()
        val top = 20.dp.toPx() // room for the value over a 100 bar
        val bottom = size.height - 22.dp.toPx() // room for the day labels
        val plotH = bottom - top
        for (v in listOf(0, 25, 50, 75, 100)) {
            val y = bottom - plotH * v / 100f
            drawLine(Hairline, Offset(axisW, y), Offset(size.width, y), strokeWidth = 1.dp.toPx(),
                pathEffect = if (v == 0) null else PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
            val t = measurer.measure("$v", axis)
            drawText(t, topLeft = Offset(0f, y - t.size.height / 2f))
        }
        if (days.isEmpty()) return@Canvas
        val slot = (size.width - axisW) / days.size
        val barW = slot * 0.62f
        days.forEachIndexed { i, d ->
            val cx = axisW + slot * i + slot / 2
            val label = measurer.measure(d.label, axis)
            drawText(label, topLeft = Offset(cx - label.size.width / 2f, bottom + 6.dp.toPx()))
            val sc = d.score
            if (sc == null) {
                // No trips that day: a faint stub on the baseline.
                drawRoundRect(Pressed, Offset(cx - barW / 2, bottom - 4.dp.toPx()), Size(barW, 4.dp.toPx()), CornerRadius(2.dp.toPx()))
                return@forEachIndexed
            }
            val h = (plotH * (sc / 100.0).toFloat().coerceIn(0.02f, 1f))
            val y = bottom - h
            val colors = if (sc == best) listOf(Color(0xFF3F7BEA), Color(0xFFA9C8FA)) else listOf(Color(0xFF8DB6F7), Color(0xFFDCE9FD))
            drawRoundRect(Brush.verticalGradient(colors, startY = y, endY = bottom), Offset(cx - barW / 2, y), Size(barW, h), CornerRadius(6.dp.toPx()))
            val v = measurer.measure("%.0f".format(sc), value)
            drawText(v, topLeft = Offset(cx - v.size.width / 2f, y - v.size.height - 2.dp.toPx()))
        }
    }
}

/** Two tiles side by side. */
@Composable
private fun TileRow(left: @Composable (Modifier) -> Unit, right: @Composable (Modifier) -> Unit) {
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        left(Modifier.weight(1f).fillMaxHeight())
        right(Modifier.weight(1f).fillMaxHeight())
    }
}

/** Inner tile of a section: icon badge, label, bold value, optional detail line. */
@Composable
private fun Tile(
    modifier: Modifier, icon: Painter, label: String, value: String, valueColor: Color = Ink,
    detail: String? = null, tint: Color = Main, badge: Color = Pressed,
) {
    Row(
        modifier.card(RoundedCornerShape(16.dp), elevation = 2.dp).padding(horizontal = 10.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        IconBadge(icon, tint, badge, 40.dp)
        Column {
            Text(label, color = SystemText, fontSize = 13.sp, lineHeight = 16.sp, maxLines = 1)
            Text(value, color = valueColor, fontSize = 20.sp, fontWeight = FontWeight.Bold, lineHeight = 24.sp, maxLines = 1)
            detail?.let { Text(it, color = Muted, fontSize = 11.sp, lineHeight = 14.sp) }
        }
    }
}

@Composable
private fun TipRow(title: String, detail: String) {
    Row(
        Modifier.fillMaxWidth().card(RoundedCornerShape(14.dp), elevation = 1.dp).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconBadge(Icons.Rounded.Lightbulb, size = 34.dp)
        Column(Modifier.weight(1f)) {
            Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text(detail, color = Muted, fontSize = 12.sp, lineHeight = 16.sp)
        }
    }
}

@Composable
private fun NavRow(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().card().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconBadge(icon, size = 40.dp)
        Column(Modifier.weight(1f)) {
            Text(title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = Muted, fontSize = 12.sp)
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = Main)
    }
}

/** White section card with the mockup's bold title and grey subtitle. */
@Composable
private fun Section(title: String? = null, subtitle: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().card().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (title != null) Column(Modifier.padding(start = 4.dp, bottom = 2.dp)) {
            Text(title, style = SectionTitleStyle)
            subtitle?.let { Text(it, color = Muted, fontSize = 13.sp) }
        }
        content()
    }
}
