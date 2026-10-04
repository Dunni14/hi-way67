package dev.driverguardian.ui

import android.content.Context
import android.graphics.Color as AndroidColor
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.mapbox.bindgen.Value
import com.mapbox.geojson.Point
import com.mapbox.maps.CameraOptions
import com.mapbox.maps.EdgeInsets
import com.mapbox.maps.ImageHolder
import com.mapbox.maps.MapView
import com.mapbox.maps.Style
import com.mapbox.maps.plugin.LocationPuck2D
import com.mapbox.maps.plugin.PuckBearing
import com.mapbox.maps.plugin.animation.camera
import com.mapbox.maps.plugin.compass.compass
import com.mapbox.maps.plugin.gestures.gestures
import com.mapbox.maps.plugin.locationcomponent.location
import com.mapbox.maps.plugin.scalebar.scalebar
import com.mapbox.maps.plugin.viewport.data.FollowPuckViewportStateBearing
import com.mapbox.maps.plugin.viewport.data.FollowPuckViewportStateOptions
import com.mapbox.maps.plugin.viewport.viewport
import dev.driverguardian.R

/**
 * 3D map for the Drive tab, ported from the CoolVitals Drive screen. Created in code so a missing Mapbox
 * token shows a message in the card instead of crashing. Never sees speed: it follows the location puck.
 * Gestures are off (the driver never touches the screen while moving).
 */
class DriveMap(private val context: Context, private val container: FrameLayout) {

    private var mapView: MapView? = null
    private var bottomPaddingPx = 0.0

    /** Adds the map. Returns false (and adds nothing) when there is no usable Mapbox token. */
    fun create(): Boolean {
        if (mapView != null) return true
        if (!hasToken(context)) return false
        val mv = MapView(context)
        container.addView(mv, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        mapView = mv
        mv.compass.updateSettings { enabled = false }
        mv.scalebar.updateSettings { enabled = false }
        // The Mapbox logo and attribution stay on: they are required by the Mapbox terms.
        mv.gestures.updateSettings {
            scrollEnabled = false
            rotateEnabled = false
            pitchEnabled = false
            pinchToZoomEnabled = false
            doubleTapToZoomInEnabled = false
            doubleTouchToZoomOutEnabled = false
            quickZoomEnabled = false
            pinchScrollEnabled = false
        }
        mv.mapboxMap.setCamera(CameraOptions.Builder().center(DEFAULT_CENTER).zoom(ZOOM).pitch(PITCH).build())
        mv.mapboxMap.loadStyle(Style.STANDARD) { style ->
            STANDARD_CONFIG.forEach { (k, v) -> style.setStyleImportConfigProperty("basemap", k, v) }
        }
        mv.location.updateSettings {
            enabled = true
            puckBearingEnabled = true
            puckBearing = PuckBearing.COURSE
            locationPuck = LocationPuck2D(bearingImage = ImageHolder.from(R.drawable.drive_puck))
        }
        // Puck sits low on the card, leaving room for the road ahead and the trip button.
        container.addOnLayoutChangeListener { v, _, top, _, bottom, _, oldTop, _, oldBottom ->
            if (bottom - top != oldBottom - oldTop) onSized(v.height)
        }
        follow()
        return true
    }

    private fun onSized(heightPx: Int) {
        bottomPaddingPx = heightPx / 3.0
        follow()
    }

    private fun follow() {
        val mv = mapView ?: return
        val options = FollowPuckViewportStateOptions.Builder()
            .pitch(PITCH)
            .zoom(ZOOM)
            .bearing(FollowPuckViewportStateBearing.SyncWithLocationPuck)
            .padding(EdgeInsets(0.0, 0.0, bottomPaddingPx, 0.0))
            .build()
        // Animated, never a snap.
        mv.viewport.transitionTo(mv.viewport.makeFollowPuckViewportState(options))
    }

    companion object {
        private const val PITCH = 60.0
        private const val ZOOM = 17.5
        private val DEFAULT_CENTER: Point = Point.fromLngLat(-83.7430, 42.2808)

        /** Mapbox Standard `basemap` import, light and monochrome to match the Drive tab. */
        private val STANDARD_CONFIG: Map<String, Value> = mapOf(
            "lightPreset" to Value.valueOf("day"),
            "theme" to Value.valueOf("monochrome"),
            "showPointOfInterestLabels" to Value.valueOf(false),
            "showTransitLabels" to Value.valueOf(false),
            "showPlaceLabels" to Value.valueOf(false),
            "showRoadLabels" to Value.valueOf(true),
            "show3dObjects" to Value.valueOf(true),
        )

        /** The SDK reads the string resource `mapbox_access_token`. Missing, blank or the placeholder means no map. */
        fun hasToken(context: Context): Boolean {
            val id = context.resources.getIdentifier("mapbox_access_token", "string", context.packageName)
            if (id == 0) return false
            val token = context.getString(id).trim()
            return token.isNotEmpty() && !token.startsWith("YOUR_")
        }
    }
}

/** The 3D map filling its parent. Shows a short note instead when the Mapbox token is not set up. */
@Composable
fun DriveMapView(modifier: Modifier = Modifier) {
    AndroidView(modifier = modifier, factory = { ctx ->
        FrameLayout(ctx).also { container ->
            if (!DriveMap(ctx, container).create()) {
                container.addView(TextView(ctx).apply {
                    text = "Map unavailable: add the Mapbox token as mapbox_access_token in res/values/mapbox_access_token.xml"
                    setTextColor(AndroidColor.WHITE)
                    gravity = Gravity.CENTER
                    setPadding(32, 32, 32, 32)
                }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        }
    })
}
