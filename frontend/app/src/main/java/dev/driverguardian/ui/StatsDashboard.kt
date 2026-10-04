package dev.driverguardian.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.driverguardian.R
import dev.driverguardian.net.HistoryApi
import dg.core.DriverStats

/**
 * Stats tab (Figma "Driving · Stats"): the last 7 days of the driver's report cards from the backend
 * (GET /drivers/{id}/stats, Tiger Data), with Trip history as a submenu. Only metrics the system
 * actually measures are shown; no week-over-week deltas (raw history is kept 7 days).
 */
@Composable
fun StatsDashboard(api: HistoryApi, driverHint: String, onOpenLastReport: (() -> Unit)?) {
    var page by remember { mutableStateOf("dash") }
    var stats by remember { mutableStateOf<DriverStats?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    if (page == "history") {
        TripHistoryScreen(api, driverHint, onOpenLastReport, onBack = { page = "dash" })
        return
    }

    LaunchedEffect(reload) {
        error = null
        runCatching {
            val name = api.driverName() ?: driverHint.ifBlank { null } ?: error("no driver name")
            api.stats(name)
        }.onSuccess { stats = it }.onFailure { error = it.message ?: "couldn't reach the backend" }
    }

    Column(
        Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Text(
                    "Driving · Stats", color = OnSurface, fontSize = 16.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(TabBg).padding(horizontal = 18.dp, vertical = 8.dp),
                )
            }
        }
        val s = stats
        when {
            error != null -> Panel { Text("Couldn't load stats: $error. Is the backend running and the host in Settings right?", color = SystemText, fontSize = 14.sp) }
            s == null -> Text("Loading…", color = SystemText, fontSize = 14.sp)
            else -> {
                ScoreCard(s)
                WeeklyTrends(s)
                SectionTitle("Behavior insights", "From the risk engine's analysis of your drives")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Insight(Modifier.weight(1f), R.drawable.ic_attention, "Attention", s.attention.value ?: "--",
                        s.attention.calmShare?.let { "calm %.0f%% of the time".format(it * 100) })
                    Insight(Modifier.weight(1f), R.drawable.ic_eye_tracking, "Eye tracking", s.eyeTracking.value ?: "--",
                        if (s.eyeTracking.microsleeps > 0) "%.0f microsleeps".format(s.eyeTracking.microsleeps) else "longest %.1f s".format(s.eyeTracking.longestClosureS))
                }
                SectionTitle("Driving patterns", "Key driving metrics from this week")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Metric(Modifier.weight(1f), "Average speed", s.avgSpeedMph?.let { "%.0f mph".format(it) } ?: "--")
                    Metric(Modifier.weight(1f), "Harsh braking", "%.0f".format(s.hardBrakes))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Metric(Modifier.weight(1f), "Night driving", s.nightShare?.let { "%.0f%%".format(it * 100) } ?: "--")
                    Metric(Modifier.weight(1f), "Distance", "%.1f mi".format(s.distanceMi))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Metric(Modifier.weight(1f), "Yawns", "%.0f".format(s.yawns))
                    Metric(Modifier.weight(1f), "Microsleeps", "%.0f".format(s.eyeTracking.microsleeps))
                }
                if (s.tips.isNotEmpty()) {
                    SectionTitle("Recommendations", "Based on this week's drives")
                    Panel {
                        s.tips.forEachIndexed { i, t ->
                            if (i > 0) Spacer(Modifier.height(10.dp))
                            Text(t.title, color = OnSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                            Text(t.detail, color = SystemText, fontSize = 13.sp)
                        }
                    }
                }
            }
        }
        NavRow("Trip history", "Every stored trip and its report card") { page = "history" }
        onOpenLastReport?.let { NavRow("Last trip's report card", "The card shown when your last trip ended", it) }
        TextButton(onClick = { reload++ }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Refresh", color = Main) }
    }
}

@Composable
private fun ScoreCard(s: DriverStats) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ScoreRing(s.safetyScore, Modifier.size(96.dp))
            Column(Modifier.weight(1f)) {
                Text("Driving\nSafety Score", color = OnSurface, fontSize = 16.sp, lineHeight = 19.sp)
                val score = s.safetyScore
                Text(
                    when {
                        score == null -> "No trips this week yet."
                        score >= 85 -> "Great driving this week!"
                        score >= 70 -> "Mostly safe driving this week."
                        else -> "Some risky drives this week."
                    },
                    color = SystemText, fontSize = 12.sp,
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth()) {
            Count(Modifier.weight(1f), "${s.trips}", "Trips", OnSurface)
            Count(Modifier.weight(1f), "${s.safeTrips}", "Safe trips", Good)
            Count(Modifier.weight(1f), "${s.riskEvents}", "Risk events", if (s.riskEvents > 0) Bad else OnSurface)
        }
    }
}

@Composable
private fun ScoreRing(score: Double?, modifier: Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 10.dp.toPx()
            val inset = stroke / 2
            val arc = Size(size.width - stroke, size.height - stroke)
            drawArc(Pressed, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
            if (score != null) drawArc(Main, -90f, (score / 100.0 * 360).toFloat(), false, Offset(inset, inset), arc, style = Stroke(stroke, cap = StrokeCap.Round))
        }
        Text(score?.let { "%.0f".format(it) } ?: "--", color = OnSurface, fontSize = 32.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Count(modifier: Modifier, value: String, label: String, color: androidx.compose.ui.graphics.Color) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = color, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(label, color = SystemText, style = Label)
    }
}

/** Safety score per day (last 7 days); empty days show as a faint stub. */
@Composable
private fun WeeklyTrends(s: DriverStats) {
    Panel {
        Text("Weekly trends", color = OnSurface, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        Text("Safety score, last ${s.days} days", color = SystemText, style = Label)
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth().height(150.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
            s.daily.forEach { d ->
                Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
                    Text(d.score?.let { "%.0f".format(it) } ?: "", color = SystemText, fontSize = 11.sp)
                    val frac = ((d.score ?: 0.0) / 100.0).toFloat().coerceIn(0.03f, 1f)
                    Box(
                        Modifier.fillMaxWidth().fillMaxHeight(frac * 0.8f).clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp))
                            .background(if (d.score == null) Pressed else Main.copy(alpha = 0.75f)),
                    )
                    Text(d.label, color = SystemText, fontSize = 11.sp, textAlign = TextAlign.Center)
                }
            }
        }
    }
}

@Composable
private fun Insight(modifier: Modifier, icon: Int, label: String, value: String, detail: String?) {
    Column(modifier.clip(CardShape).background(TabBg).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Image(painterResource(icon), contentDescription = null, modifier = Modifier.size(22.dp))
            Text(label, color = SystemText, style = Label)
        }
        Text(value, color = if (value == "GOOD" || value == "NORMAL") Main else if (value == "--") SystemText else Bad, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        detail?.let { Text(it, color = SystemText, fontSize = 11.sp) }
    }
}

@Composable
private fun Metric(modifier: Modifier, label: String, value: String) {
    Column(modifier.clip(CardShape).background(TabBg).padding(12.dp)) {
        Text(label, color = SystemText, style = Label)
        Text(value, color = OnSurface, fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun SectionTitle(title: String, subtitle: String) {
    Column(Modifier.padding(top = 4.dp)) {
        Text(title, color = OnSurface, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        Text(subtitle, color = SystemText, style = Label)
    }
}

@Composable
private fun NavRow(title: String, subtitle: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(CardShape).background(TabBg).clickable(onClick = onClick).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Main, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(subtitle, color = SystemText, style = Label)
        }
        Text("›", color = SystemText, fontSize = 20.sp)
    }
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(CardShape).background(TabBg).padding(14.dp), content = content)
}
