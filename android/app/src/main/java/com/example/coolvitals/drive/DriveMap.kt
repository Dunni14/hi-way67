package com.example.coolvitals.drive

import android.content.Context
import android.view.ViewGroup
import android.widget.FrameLayout
import com.example.coolvitals.R
import com.mapbox.bindgen.Value
import com.mapbox.geojson.Point
import com.mapbox.maps.EdgeInsets
import com.mapbox.maps.MapView
import com.mapbox.maps.Style
import com.mapbox.maps.extension.style.layers.addLayer
import com.mapbox.maps.extension.style.layers.generated.lineLayer
import com.mapbox.maps.extension.style.layers.properties.generated.LineCap
import com.mapbox.maps.extension.style.layers.properties.generated.LineJoin
import com.mapbox.maps.extension.style.sources.addSource
import com.mapbox.maps.extension.style.sources.generated.GeoJsonSource
import com.mapbox.maps.extension.style.sources.generated.geoJsonSource
import com.mapbox.maps.extension.style.sources.getSourceAs
import com.mapbox.maps.plugin.PuckBearing
import com.mapbox.maps.plugin.animation.camera
import com.mapbox.maps.plugin.compass.compass
import com.mapbox.maps.plugin.gestures.gestures
import com.mapbox.maps.plugin.locationcomponent.createDefault2DPuck
import com.mapbox.maps.plugin.locationcomponent.location
import com.mapbox.maps.plugin.scalebar.scalebar
import com.mapbox.maps.plugin.viewport.data.FollowPuckViewportStateBearing
import com.mapbox.maps.plugin.viewport.data.FollowPuckViewportStateOptions
import com.mapbox.maps.plugin.viewport.viewport
import com.mapbox.maps.CameraOptions
import com.mapbox.maps.ImageHolder
import com.mapbox.maps.plugin.LocationPuck2D

/**
 * The 3D map in the Drive screen. Created in code, never in the layout, so a missing Mapbox token shows an
 * error in the map box instead of crashing inflation. It never sees speed: only [onCourse], the route and
 * the interactive flag reach it.
 */
class DriveMap(private val context: Context, private val container: FrameLayout) {

    /** Gestures are off while driving. Turn on for a parked state. */
    var interactive: Boolean = false
        set(value) {
            field = value
            applyGestures()
        }

    private var mapView: MapView? = null
    private var styleReady = false
    private var pendingRoute: String? = null
    private var lastBearing: Double? = null
    private var holdingBearing = false
    private var bottomPaddingPx = 0.0
    private var followLocation = false

    val isCreated get() = mapView != null

    /**
     * Adds the map. Returns false (and adds nothing) when there is no usable Mapbox token.
     * Without location permission the camera sits on a default spot and does not follow anything.
     */
    fun create(locationGranted: Boolean): Boolean {
        if (mapView != null) return true
        if (!hasToken(context)) return false
        val mv = MapView(context)
        container.addView(mv, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        mapView = mv
        mv.compass.updateSettings { enabled = false }
        mv.scalebar.updateSettings { enabled = false }
        // The Mapbox logo and attribution stay on: they are required by the Mapbox terms.
        applyGestures()

        mv.mapboxMap.setCamera(CameraOptions.Builder().center(DEFAULT_CENTER).zoom(15.0).pitch(PITCH).build())
        mv.mapboxMap.loadStyle(Style.STANDARD) { style ->
            STANDARD_CONFIG.forEach { (k, v) -> style.setStyleImportConfigProperty("basemap", k, v) }
            styleReady = true
            applyRoute(pendingRoute)
        }
        if (locationGranted) enableLocation()
        return true
    }

    private fun enableLocation() {
        val mv = mapView ?: return
        mv.location.updateSettings {
            enabled = true
            puckBearingEnabled = true
            puckBearing = PuckBearing.COURSE
            locationPuck = LocationPuck2D(bearingImage = ImageHolder.from(R.drawable.drive_puck))
        }
        followLocation = true
        follow(constantBearing = null)
    }

    /** Bottom padding of about a third of the map height puts the puck low and shows more road ahead. */
    fun onMapSized(heightPx: Int) {
        bottomPaddingPx = heightPx / 3.0
        if (followLocation) follow(if (holdingBearing) lastBearing else null)
    }

    /**
     * Course from the 1 Hz fixes. Under 3 m/s the last bearing is held (constant), above it the camera
     * syncs with the puck's course. Switches the camera only when the mode changes.
     */
    fun onCourse(speedMps: Double, courseDeg: Double?) {
        val held = heldBearing(speedMps, courseDeg, lastBearing)
        val shouldHold = speedMps < HOLD_BEARING_UNDER_MPS && held != null
        lastBearing = held
        if (followLocation && shouldHold != holdingBearing) {
            holdingBearing = shouldHold
            follow(if (shouldHold) held else null)
        }
    }

    private fun follow(constantBearing: Double?) {
        val mv = mapView ?: return
        val bearing = if (constantBearing == null) FollowPuckViewportStateBearing.SyncWithLocationPuck else FollowPuckViewportStateBearing.Constant(constantBearing)
        val options = FollowPuckViewportStateOptions.Builder()
            .pitch(PITCH)
            .zoom(ZOOM)
            .bearing(bearing)
            .padding(EdgeInsets(0.0, 0.0, bottomPaddingPx, 0.0))
            .build()
        // Animated, never a snap.
        mv.viewport.transitionTo(mv.viewport.makeFollowPuckViewportState(options))
    }

    private fun applyGestures() {
        val on = interactive
        mapView?.gestures?.updateSettings {
            scrollEnabled = on
            rotateEnabled = on
            pitchEnabled = on
            pinchToZoomEnabled = on
            doubleTapToZoomInEnabled = on
            doubleTouchToZoomOutEnabled = on
            quickZoomEnabled = on
            pinchScrollEnabled = on
        }
    }

    /** GeoJSON route (a Directions geometry as a Feature). Null clears it; nothing is drawn without a destination. */
    fun setRoute(geoJson: String?) {
        pendingRoute = geoJson
        if (styleReady) applyRoute(geoJson)
    }

    private fun applyRoute(geoJson: String?) {
        val style = mapView?.mapboxMap?.style ?: return
        if (geoJson == null) {
            style.removeStyleLayer(ROUTE_FILL)
            style.removeStyleLayer(ROUTE_CASING)
            style.removeStyleSource(ROUTE_SOURCE)
            return
        }
        val existing = style.getSourceAs<GeoJsonSource>(ROUTE_SOURCE)
        if (existing != null) {
            existing.data(geoJson)
            return
        }
        style.addSource(geoJsonSource(ROUTE_SOURCE) { data(geoJson) })
        // `middle` slot of Standard: above roads, below buildings and labels. Casing first, fill on top.
        style.addLayer(lineLayer(ROUTE_CASING, ROUTE_SOURCE) {
            slot("middle")
            lineColor(context.getColor(R.color.drive_route_casing))
            lineWidth(12.0)
            lineCap(LineCap.ROUND)
            lineJoin(LineJoin.ROUND)
        })
        style.addLayer(lineLayer(ROUTE_FILL, ROUTE_SOURCE) {
            slot("middle")
            lineColor(context.getColor(R.color.drive_route))
            lineWidth(8.0)
            lineCap(LineCap.ROUND)
            lineJoin(LineJoin.ROUND)
        })
    }

    companion object {
        const val PITCH = 60.0
        const val ZOOM = 17.5
        private const val ROUTE_SOURCE = "drive-route-src"
        private const val ROUTE_CASING = "drive-route-casing"
        private const val ROUTE_FILL = "drive-route-fill"
        private val DEFAULT_CENTER: Point = Point.fromLngLat(-83.7430, 42.2808)

        /**
         * Mapbox Standard `basemap` import. `theme` is monochrome (white clay buildings); try "faded" and keep
         * whichever is closer to the mockup. Road labels stay on for context: turn off if cluttered.
         */
        val STANDARD_CONFIG: Map<String, Value> = mapOf(
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
