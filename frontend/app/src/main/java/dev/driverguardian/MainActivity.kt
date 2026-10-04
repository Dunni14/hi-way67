package dev.driverguardian

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.driverguardian.trip.TripController
import dev.driverguardian.ui.DashcamScreen
import dev.driverguardian.ui.DriverGuardianColors
import dev.driverguardian.ui.PlaceholderScreen
import dev.driverguardian.ui.TabBar
import dev.driverguardian.ui.TripHistoryScreen
import dev.driverguardian.ui.TripRecapDialog
import dev.driverguardian.ui.DebugScreen
import dev.driverguardian.ui.ReportCardScreen
import dev.driverguardian.ui.SettingsScreen

class MainActivity : ComponentActivity() {
    private val vm: TripController by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        vm.onNavigate = { q ->
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(q))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        setContent { MaterialTheme(colorScheme = DriverGuardianColors) { Root() } }
    }

    @Composable
    private fun Root() {
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        // The mic is optional: without it the app still speaks, it just can't hear replies.
        val requested = needed + Manifest.permission.RECORD_AUDIO
        fun granted() = needed.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        var ok by remember { mutableStateOf(granted()) }
        var asked by remember { mutableStateOf(false) }
        val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { ok = granted() }
        LaunchedEffect(Unit) {
            val micMissing = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
            if ((!ok || micMissing) && !asked) { asked = true; launcher.launch(requested) }
        }

        if (!ok) {
            Column(Modifier.fillMaxSize().padding(24.dp)) {
                Text("Driver Guardian needs the camera (to watch for drowsiness) and location (speed), and the microphone to hear your replies. Grant them while parked.")
                Button(onClick = { launcher.launch(requested) }) { Text("Grant permissions") }
            }
            return
        }
        var tab by remember { mutableStateOf("drive") }
        var showDebug by remember { mutableStateOf(false) }
        val ui by vm.ui.collectAsState()
        val conn by vm.connection.collectAsState()
        val voice by vm.voiceState.collectAsState()
        val settings by vm.settingsFlow.collectAsState()
        val report by vm.report.collectAsState()
        val shared by vm.sharedReport.collectAsState()
        val history by vm.history.collectAsState()
        var showReport by remember { mutableStateOf(false) }
        val parked = !ui.running || ui.speedMph < 3
        val recap by vm.recap.collectAsState()
        // Leaving the parked state always brings the driver back to the Drive tab.
        LaunchedEffect(parked) { if (!parked) { tab = "drive"; showDebug = false } }

        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                when (tab) {
                    // The report card of the trip that just ended (with what the backend shared, once it arrives); Done drops back to the history list.
                    "stats" -> report?.takeIf { showReport }?.let { ReportCardScreen(it, shared) { showReport = false } }
                        ?: TripHistoryScreen(history, onOpenLatest = if (report != null) ({ showReport = true }) else null)
                    "contacts" -> PlaceholderScreen(
                        "Contacts",
                        "Who gets alerts is set on the backend for now: contacts.json lists guardians (alerts and location) " +
                            "and friends (messages and roasts, no location). How much you share is under Settings.",
                    )
                    "settings" -> if (showDebug) DebugScreen(ui, vm.client, conn) { showDebug = false }
                        else SettingsScreen(settings, onSave = vm::saveSettings, onDebug = { showDebug = true })
                    else -> DashcamScreen(
                        ui = ui, conn = conn, voice = voice,
                        onStart = vm::startTrip, onEnd = vm::endTrip,
                        liveSensing = !settings.demoMode,
                    )
                }
            }
            TabBar(selected = tab, parked = parked) { tab = it; showDebug = false }
        }
        // When a trip ends, a popup sums it up; the full report card is one tap away.
        recap?.let { r ->
            TripRecapDialog(
                r, onDone = vm::dismissRecap,
                onReport = if (report != null) ({ vm.dismissRecap(); tab = "stats"; showReport = true }) else null,
            )
        }
    }
}
