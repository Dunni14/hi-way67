package dev.driverguardian.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.driverguardian.net.HistoryApi
import dg.core.History
import dg.core.TripCard
import dg.core.TripRow
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val DayTime = DateTimeFormatter.ofPattern("EEE MMM d · h:mm a")

private fun gradeTint(g: String) = when (g) {
    "A", "B" -> Good
    "C" -> Warn
    "?" -> SystemText
    else -> Bad
}

private fun localTime(iso: String): String = runCatching { DayTime.format(Instant.parse(iso).atZone(ZoneId.systemDefault())) }.getOrDefault(iso)

private fun duration(seconds: Double): String {
    val s = seconds.toLong()
    return if (s >= 3600) "%dh %02dm".format(s / 3600, (s % 3600) / 60) else if (s >= 60) "${s / 60} min" else "$s s"
}

private fun tripDuration(t: TripRow): String? = runCatching {
    duration(Duration.between(Instant.parse(t.startedAt), Instant.parse(t.endedAt ?: return null)).seconds.toDouble())
}.getOrNull()

/**
 * Stats tab: the trips the backend's risk engine stored (Tiger Data), newest first. [driverHint] is the
 * name from Settings; the backend's own driver name (from /health) wins, since that is what trips are
 * stored under.
 */
@Composable
fun TripHistoryScreen(api: HistoryApi, driverHint: String, onOpenLastReport: (() -> Unit)?, onBack: (() -> Unit)? = null) {
    var trips by remember { mutableStateOf<List<TripRow>?>(null) }
    var driver by remember { mutableStateOf(driverHint) }
    var error by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<TripRow?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        error = null
        runCatching {
            val name = api.driverName() ?: driverHint.ifBlank { null } ?: error("no driver name")
            driver = name
            api.trips(name)
        }.onSuccess { trips = it }.onFailure { error = it.message ?: "couldn't reach the backend" }
    }

    open?.let { row -> TripDetailScreen(api, row) { open = null }; return }

    Column(Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        onBack?.let { TextButton(onClick = it) { Text("‹ Stats", color = Main) } }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Trip history", color = OnSurface, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                Text(if (driver.isBlank()) "Stored on Tiger Data" else "$driver · stored on Tiger Data", color = SystemText, style = Label)
            }
            TextButton(onClick = { reload++ }) { Text("Refresh", color = Main) }
        }
        onOpenLastReport?.let { openLast ->
            Card(Modifier.clickable { openLast() }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Last trip's report card", color = Main, fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                    Text("›", color = SystemText, fontSize = 20.sp)
                }
            }
        }
        when {
            error != null -> Card { Text("Couldn't load trips: $error. Is the backend running and the host in Settings right?", color = SystemText, fontSize = 14.sp) }
            trips == null -> Text("Loading…", color = SystemText, fontSize = 14.sp)
            trips!!.isEmpty() -> Card { Text("No trips stored for $driver yet. Start one on the Drive tab.", color = SystemText, fontSize = 14.sp) }
            else -> trips!!.forEach { t -> TripRowCard(t) { open = t } }
        }
    }
}

@Composable
private fun TripRowCard(t: TripRow, onClick: () -> Unit) {
    Card(Modifier.clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            GradeBadge(t.displayGrade, 44)
            Column(Modifier.weight(1f)) {
                Text(localTime(t.startedAt), color = OnSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                val parts = listOfNotNull(
                    tripDuration(t) ?: "in progress",
                    t.cardScore?.let { "score %.0f".format(it) },
                    "peak risk %.0f".format(t.maxScore),
                )
                Text(parts.joinToString(" · "), color = SystemText, style = Label)
            }
            Text("›", color = SystemText, fontSize = 20.sp)
        }
    }
}

/** One stored trip: the persisted report card from the backend. */
@Composable
fun TripDetailScreen(api: HistoryApi, row: TripRow, onBack: () -> Unit) {
    var card by remember(row.tripId) { mutableStateOf<TripCard?>(null) }
    var error by remember(row.tripId) { mutableStateOf<String?>(null) }
    LaunchedEffect(row.tripId) {
        runCatching { api.card(row.tripId) }.onSuccess { card = it }.onFailure { error = it.message ?: "failed" }
    }
    Column(Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onBack) { Text("‹ All trips", color = Main) }
        Text(localTime(row.startedAt), color = OnSurface, fontSize = 20.sp, fontWeight = FontWeight.Medium)
        val c = card
        when {
            error != null -> Card { Text("Couldn't load this trip: $error", color = SystemText, fontSize = 14.sp) }
            c == null -> Text("Loading…", color = SystemText, fontSize = 14.sp)
            else -> {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        GradeBadge(c.grade, 64)
                        Column {
                            Text("Safety score %.0f".format(c.score), color = OnSurface, fontSize = 18.sp, fontWeight = FontWeight.Medium)
                            Text(
                                listOf(duration(c.metrics.durationS), "%.1f mi".format(c.metrics.distanceMi), if (c.metrics.nightTrip) "night drive" else null)
                                    .filterNotNull().joinToString(" · ") + if (c.provisional) " · provisional" else "",
                                color = SystemText, style = Label,
                            )
                        }
                    }
                }
                Card {
                    Text("Risk over time", color = OnSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(8.dp))
                    SeriesChart(c, Modifier.fillMaxWidth().height(150.dp))
                    Spacer(Modifier.height(8.dp))
                    TierBar(c.metrics.tierSeconds)
                }
                val alerts = History.alertSummary(c)
                val reasons = History.overrideSummary(c)
                Card {
                    Text("What happened", color = OnSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    if (alerts.isEmpty() && reasons.isEmpty()) Fact("Alerts", "none, calm drive")
                    alerts.forEach { (label, n) -> Fact(label, "$n") }
                    reasons.forEach { (label, n) -> Fact(label, "$n×") }
                }
                Card {
                    Text("Drive", color = OnSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Fact("Average speed", "%.0f mph".format(c.metrics.avgSpeedMph))
                    Fact("Top speed", "%.0f mph".format(c.metrics.maxSpeedMph))
                    Fact("Yawns", "%.0f".format(c.metrics.yawns))
                    Fact("Longest eye closure", "%.1f s".format(c.metrics.longestEyeClosureS))
                    Fact("Hard brakes / swerves", "%.0f / %.0f".format(c.counts.hardBrakes, c.counts.swerves))
                }
            }
        }
    }
}

@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(CardShape).background(TabBg).padding(14.dp), content = content)
}

@Composable
private fun GradeBadge(grade: String, sizeDp: Int) {
    Box(Modifier.size(sizeDp.dp).clip(CircleShape).background(gradeTint(grade).copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
        Text(grade, color = gradeTint(grade), fontSize = (sizeDp * 0.45f).sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        Text(label, color = SystemText, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text(value, color = OnSurface, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

/** Score 0..100 over the trip, with the engine's tier thresholds as faint lines. */
@Composable
private fun SeriesChart(card: TripCard, modifier: Modifier) {
    val pts = card.series
    Canvas(modifier.clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp)).background(Pressed)) {
        fun y(s: Double) = size.height * (1f - (s / 100.0).toFloat().coerceIn(0f, 1f))
        for ((level, c) in listOf(40.0 to Warn, 70.0 to Bad, 85.0 to Bad)) {
            drawLine(c.copy(alpha = 0.3f), Offset(0f, y(level)), Offset(size.width, y(level)), strokeWidth = 2f)
        }
        if (pts.size < 2) return@Canvas
        val path = Path()
        pts.forEachIndexed { i, p ->
            val x = size.width * i / (pts.size - 1)
            if (i == 0) path.moveTo(x, y(p.score)) else path.lineTo(x, y(p.score))
        }
        drawPath(path, Main, style = Stroke(width = 5f))
    }
}

/** Share of the trip spent at each engine tier: calm / nudge / warning / urgent. */
@Composable
private fun TierBar(seconds: List<Double>) {
    val total = seconds.sum()
    if (total <= 0) return
    val colors = listOf(Good, Warn, Color(0xFFFB8C00), Bad)
    val names = listOf("calm", "nudge", "warning", "urgent")
    Row(Modifier.fillMaxWidth().height(10.dp).clip(CircleShape)) {
        seconds.forEachIndexed { i, s -> if (s > 0) Box(Modifier.weight((s / total).toFloat()).fillMaxHeight().background(colors.getOrElse(i) { Bad })) }
    }
    Text(
        seconds.mapIndexedNotNull { i, s -> if (s > 0) "${names.getOrElse(i) { "tier $i" }} ${duration(s)}" else null }.joinToString(" · "),
        color = SystemText, style = Label, modifier = Modifier.padding(top = 4.dp),
    )
}
