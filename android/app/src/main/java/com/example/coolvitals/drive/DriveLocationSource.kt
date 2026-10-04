package com.example.coolvitals.drive

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper

/** A good fix as the Drive screen needs it. */
data class DriveFix(val speedMps: Double, val courseDeg: Double?, val timeMs: Long)

/**
 * 1 Hz fixes from the platform GPS provider (no Play Services dependency). Applies the same filter as the
 * backend: accuracy worse than 30 m or a negative speed is dropped. The Mapbox puck uses its own provider,
 * so this feeds only the header speed and the bearing-hold rule.
 */
class DriveLocationSource(private val context: Context, private val onFix: (DriveFix) -> Unit) {
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var started = false

    private val listener = LocationListener { loc: Location ->
        val speed = if (loc.hasSpeed()) loc.speed else null
        val acc = if (loc.hasAccuracy()) loc.accuracy else null
        if (isGoodFix(acc, speed)) {
            val course = if (loc.hasBearing()) loc.bearing.toDouble() else null
            onFix(DriveFix(speed!!.toDouble(), course, System.currentTimeMillis()))
        }
    }

    /** Caller must hold ACCESS_FINE_LOCATION. */
    @SuppressLint("MissingPermission")
    fun start() {
        if (started || !manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) return
        manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, listener, Looper.getMainLooper())
        started = true
    }

    fun stop() {
        if (!started) return
        manager.removeUpdates(listener)
        started = false
    }
}
