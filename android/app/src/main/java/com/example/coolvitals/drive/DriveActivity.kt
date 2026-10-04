package com.example.coolvitals.drive

import android.Manifest
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.example.coolvitals.BuildConfig
import com.example.coolvitals.R
import com.example.coolvitals.net.HttpBackend
import com.google.android.material.bottomnavigation.BottomNavigationView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The Drive screen: header, 3D map, four status boxes, bottom nav. Zones are fixed, nothing scrolls except the
 * status grid when it would squeeze the map below its minimum.
 *
 * Slots (the XML equivalent of the spec's Compose slots): [statusBoxes] come from state, anything can be drawn
 * over the map in `mapOverlay`, and the header and bottom nav are plain views that can be swapped.
 */
class DriveActivity : AppCompatActivity() {

    private val vm: DriveViewModel by viewModels()
    private lateinit var map: DriveMap
    private lateinit var location: DriveLocationSource

    private lateinit var root: View
    private lateinit var header: View
    private lateinit var nav: BottomNavigationView
    private lateinit var gridScroll: MaxHeightScrollView
    private lateinit var grid: LinearLayout
    private val boxViews = LinkedHashMap<String, StatusBoxView>()

    /** Gestures on the map, off by default. Turn on for a parked state. */
    var mapInteractive: Boolean
        get() = map.interactive
        set(value) {
            map.interactive = value
        }

    private var presage: PresageSource? = null

    private val requestPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        onPermission(hasLocationPermission())
        startPresage()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_drive)
        root = findViewById(R.id.driveRoot)
        header = findViewById(R.id.driveHeader)
        nav = findViewById(R.id.bottomNav)
        gridScroll = findViewById(R.id.gridScroll)
        grid = findViewById(R.id.statusGrid)
        map = DriveMap(this, findViewById(R.id.mapContainer))
        location = DriveLocationSource(this) { vm.onFix(it); map.onCourse(it.speedMps, it.courseDeg) }

        applySystemInsets()
        setUpNav()
        watchLayout()

        val granted = hasLocationPermission()
        vm.onPermission(granted)
        if (intent.getBooleanExtra(EXTRA_DEMO, false)) vm.demo()
        if (granted) startSession()
        showMap(granted)
        val missing = listOfNotNull(
            Manifest.permission.ACCESS_FINE_LOCATION.takeIf { !granted },
            Manifest.permission.ACCESS_COARSE_LOCATION.takeIf { !granted },
            Manifest.permission.CAMERA.takeIf { presageEnabled() && !hasCameraPermission() },
        )
        if (missing.isNotEmpty() && !intent.getBooleanExtra(EXTRA_DEMO, false)) requestPermissions.launch(missing.toTypedArray())

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { vm.state.collect { render(it) } }
                launch {
                    while (true) {
                        vm.onTick(System.currentTimeMillis())
                        delay(1000)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        vm.setActive(true)
        if (hasLocationPermission()) location.start()
        startPresage()
    }

    override fun onStop() {
        vm.setActive(false)
        location.stop()
        stopPresage()
        super.onStop()
    }

    /** Presage needs its API key, the camera permission, and not be in demo mode. */
    private fun presageEnabled() = BuildConfig.PRESAGE_API_KEY.isNotBlank() && !intent.getBooleanExtra(EXTRA_DEMO, false)

    /**
     * Front camera + Presage into the small preview. The camera is held only while this screen is visible
     * (released in onStop), and never in demo mode, so `MainActivity` can have it when this one does not.
     */
    private fun startPresage() {
        if (!presageEnabled() || !hasCameraPermission() || presage != null) return
        val preview = findViewById<androidx.camera.view.PreviewView>(R.id.presagePreview)
        val hint = findViewById<TextView>(R.id.presageHint)
        preview.visibility = View.VISIBLE
        presage = PresageSource(this, this, preview, vm.presage, BuildConfig.PRESAGE_API_KEY) { msg ->
            hint.text = msg ?: ""
            hint.visibility = if (msg == null) View.GONE else View.VISIBLE
        }.also {
            vm.setPresageActive(true)
            it.start()
        }
    }

    private fun stopPresage() {
        presage?.stop()
        presage = null
        vm.setPresageActive(false)
        findViewById<View>(R.id.presagePreview).visibility = View.GONE
        findViewById<View>(R.id.presageHint).visibility = View.GONE
    }

    /** Posts a window to the backend every 10 s: GPS plus Presage fields while the camera runs. No-op in demo mode. */
    private fun startSession() {
        vm.startSession(HttpBackend(BuildConfig.BACKEND_URL), BuildConfig.DRIVER_ID, BuildConfig.SHARE_LOCATION)
    }

    private fun hasCameraPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun onPermission(granted: Boolean) {
        vm.onPermission(granted)
        if (granted) {
            // The map was created without following; recreate it now that the puck can work.
            findViewById<FrameLayout>(R.id.mapContainer).removeAllViews()
            map = DriveMap(this, findViewById(R.id.mapContainer)).also { it.interactive = map.interactive }
            showMap(true)
            location.start()
            startSession()
        }
    }

    private fun showMap(locationGranted: Boolean) {
        val ok = map.create(locationGranted)
        findViewById<View>(R.id.mapError).visibility = if (ok) View.GONE else View.VISIBLE
        findViewById<View>(R.id.mapBox).post { map.onMapSized(findViewById<View>(R.id.mapBox).height) }
    }

    /** Targeting SDK 35+ draws edge to edge: keep the screen padding and add the system bars on top. */
    private fun applySystemInsets() {
        val pad = resources.getDimensionPixelSize(R.dimen.drive_screen_padding)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, windowInsets ->
            val bars: Insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun setUpNav() {
        nav.selectedItemId = R.id.nav_drive
        nav.setOnItemSelectedListener { item ->
            if (item.itemId == R.id.nav_drive) {
                true
            } else {
                Toast.makeText(this, R.string.drive_nav_soon, Toast.LENGTH_SHORT).show()
                false // stay on Drive
            }
        }
    }

    /** Keeps the status grid from squeezing the map under its minimum height; past that it scrolls. */
    private fun watchLayout() {
        val update = {
            val r = resources
            gridScroll.maxHeightPx = gridMaxHeightPx(
                rootHeight = root.height,
                paddingTotal = root.paddingTop + root.paddingBottom,
                headerHeight = header.height,
                navHeight = nav.height,
                gap = r.getDimensionPixelSize(R.dimen.drive_gap),
                mapMin = r.getDimensionPixelSize(R.dimen.drive_map_min_height),
            )
        }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> update() }
        findViewById<View>(R.id.mapBox).addOnLayoutChangeListener { v, _, top, _, bottom, _, oldTop, _, oldBottom ->
            if (bottom - top != oldBottom - oldTop) map.onMapSized(v.height)
        }
    }

    private var lastRoute: String? = null

    private fun render(s: DriveUiState) {
        // Header
        val speed = findViewById<TextView>(R.id.speedText)
        speed.text = speedText(s.speedMph)
        speed.setTextColor(ContextCompat.getColor(this, if (isOverLimit(s.speedMph, s.limitMph)) R.color.drive_speed_over else R.color.drive_great))
        findViewById<TextView>(R.id.avatarText).text = s.driverInitial
        val (title, subtitle) = pillText(s.tripState, s.online)
        findViewById<TextView>(R.id.pillTitle).text = title
        findViewById<TextView>(R.id.pillSubtitle).apply {
            text = subtitle ?: ""
            visibility = if (subtitle == null) View.GONE else View.VISIBLE
        }
        findViewById<TextView>(R.id.limitText).text = limitText(s.limitMph, s.limitSource)
        findViewById<View>(R.id.limitFallbackDot).visibility = if (showFallbackDot(s.limitSource, s.limitMph)) View.VISIBLE else View.GONE

        // Map overlay: alert banner by tier
        val banner = findViewById<TextView>(R.id.alertBanner)
        val b = bannerFor(s.tier)
        if (b == null) {
            banner.visibility = View.GONE
        } else {
            banner.setText(b.textRes)
            banner.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, b.colorRes))
            banner.visibility = View.VISIBLE
        }

        // Route only when it changes: the map is not touched on a speed tick.
        if (s.routeGeoJson != lastRoute) {
            lastRoute = s.routeGeoJson
            map.setRoute(s.routeGeoJson)
        }

        bindBoxes(s.boxes)
    }

    /** Lays the boxes out two per row. Views are reused by id so a level change animates instead of rebuilding. */
    private fun bindBoxes(boxes: List<StatusBox>) {
        val ids = boxes.map { it.id }
        if (ids != boxViews.keys.toList()) {
            boxViews.clear()
            grid.removeAllViews()
            val gap = resources.getDimensionPixelSize(R.dimen.drive_gap)
            boxes.chunked(2).forEachIndexed { rowIndex, pair ->
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                pair.forEachIndexed { i, box ->
                    val v = StatusBoxView(this)
                    boxViews[box.id] = v
                    row.addView(v, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                        if (i == 1) marginStart = gap
                    })
                }
                if (pair.size == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f).apply { marginStart = gap })
                grid.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    if (rowIndex > 0) topMargin = gap
                })
            }
        }
        boxes.forEach { boxViews.getValue(it.id).bind(it) }
    }

    companion object {
        /** `adb shell am start -n <pkg>/.drive.DriveActivity --ez demo true` shows fake data. */
        const val EXTRA_DEMO = "demo"
    }
}
