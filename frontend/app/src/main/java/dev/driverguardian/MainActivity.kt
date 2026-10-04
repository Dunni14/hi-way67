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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.windowInsetsPadding
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
import dev.driverguardian.net.Conn
import dev.driverguardian.trip.TripController
import dev.driverguardian.ui.DashcamScreen
import dev.driverguardian.ui.DriverGuardianColors
import dev.driverguardian.ui.DriverGuardianTypography
import dev.driverguardian.ui.ContactsScreen
import dev.driverguardian.ui.ScreenBg
import dev.driverguardian.ui.TabBar
import dev.driverguardian.ui.LocalTripHistoryScreen
import dev.driverguardian.ui.StatsDashboard
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
        // Draw behind the camera cutout so the top of the screen is the app's background, not a black strip.
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        vm.onNavigate = { q ->
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(q))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        setContent { MaterialTheme(colorScheme = DriverGuardianColors, typography = DriverGuardianTypography) { Root() } }
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
        val contacts by vm.contacts.collectAsState()
        val shared by vm.sharedReport.collectAsState()
        val localHistory by vm.localHistory.collectAsState()
        var showReport by remember { mutableStateOf(false) }
        val parked = !ui.running || ui.speedMph < 3
        val recap by vm.recap.collectAsState()
        // Leaving the parked state always brings the driver back to the Drive tab.
        LaunchedEffect(parked) { if (!parked) { tab = "drive"; showDebug = false } }

        // The background fills the cutout area; the content starts below it.
        Column(Modifier.fillMaxSize().background(ScreenBg).windowInsetsPadding(WindowInsets.displayCutout)) {
            Box(Modifier.weight(1f)) {
                when (tab) {
                    // The report card of the trip that just ended (with what the backend shared, once it arrives); Done drops back to Stats.
                    // Stats is the Tiger Data dashboard; without a backend connection, the trips kept on the phone.
                    "stats" -> {
                        val openLatest = if (report != null) ({ showReport = true }) else null
                        report?.takeIf { showReport }?.let { ReportCardScreen(it, shared) { showReport = false } }
                            ?: if (conn == Conn.CONNECTED) StatsDashboard(api = vm.history, driverHint = settings.driverName, onOpenLastReport = openLatest)
                            else LocalTripHistoryScreen(localHistory, onOpenLatest = openLatest)
                    }
                    "contacts" -> ContactsScreen(
                        state = contacts, conn = conn,
                        onRefresh = vm::refreshContacts, onAdd = vm::addContact, onRemove = vm::removeContact,
                        onGuardian = vm::setGuardian, onCloseInvite = vm::clearInvite, onJoinedSeen = vm::clearJoined,
                    )
                    "settings" -> if (showDebug) DebugScreen(ui, vm.client, conn) { showDebug = false }
                        else SettingsScreen(settings, onSave = vm::saveSettings, onDebug = { showDebug = true })
                    else -> DashcamScreen(
                        ui = ui, conn = conn, voice = voice,
                        onStart = vm::startTrip, onEnd = vm::endTrip,
                        liveSensing = !settings.demoMode,
                        driverName = settings.driverName,
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
