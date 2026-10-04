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
import dev.driverguardian.ui.DebugScreen
import dev.driverguardian.ui.ReportScreen
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
        setContent { MaterialTheme(colorScheme = androidx.compose.material3.darkColorScheme()) { Root() } }
    }

    @Composable
    private fun Root() {
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        fun granted() = needed.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        var ok by remember { mutableStateOf(granted()) }
        var asked by remember { mutableStateOf(false) }
        val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { ok = granted() }
        LaunchedEffect(Unit) { if (!ok && !asked) { asked = true; launcher.launch(needed) } }

        if (!ok) {
            Column(Modifier.fillMaxSize().padding(24.dp)) {
                Text("Driver Guardian needs the camera (to watch for drowsiness) and location (speed). Grant them while parked.")
                Button(onClick = { launcher.launch(needed) }) { Text("Grant permissions") }
            }
            return
        }
        var screen by remember { mutableStateOf("dashcam") }
        val ui by vm.ui.collectAsState()
        val conn by vm.connection.collectAsState()
        val settings by vm.settingsFlow.collectAsState()
        val report by vm.lastReport.collectAsState()
        report?.let { ReportScreen(it, onDone = vm::dismissReport); return }
        when (screen) {
            "debug" -> DebugScreen(ui, vm.client, conn) { screen = "dashcam" }
            "settings" -> SettingsScreen(settings, onSave = vm::saveSettings) { screen = "dashcam" }
            else -> DashcamScreen(
                ui = ui, conn = conn, settings = settings, onSave = vm::saveSettings,
                onStart = vm::startTrip, onEnd = vm::endTrip,
                onDebug = { screen = "debug" }, onSettings = { screen = "settings" },
            )
        }
    }
}
