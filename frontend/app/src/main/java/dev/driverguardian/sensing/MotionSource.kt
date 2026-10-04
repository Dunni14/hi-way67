package dev.driverguardian.sensing

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Looper
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import dg.core.DriverEvent
import kotlin.math.sqrt

/** GPS speed/position plus IMU hard_brake and swerve detection. Orientation-agnostic heuristics. */
class MotionSource(
    context: Context,
    private val onMotion: (mph: Double, lat: Double?, lon: Double?) -> Unit,
    private val onEvent: (String) -> Unit,
) : SensorEventListener {
    private val fused = LocationServices.getFusedLocationProviderClient(context)
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var mph = 0.0
    private var lastEventMs = 0L

    private val locationCb = object : LocationCallback() {
        override fun onLocationResult(r: LocationResult) {
            val l = r.lastLocation ?: return
            mph = if (l.hasSpeed()) l.speed * 2.23694 else 0.0
            onMotion(mph, l.latitude, l.longitude)
        }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000).build()
        runCatching { fused.requestLocationUpdates(req, locationCb, Looper.getMainLooper()) }
        sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
        sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    }

    fun stop() {
        fused.removeLocationUpdates(locationCb)
        sensors.unregisterListener(this)
    }

    override fun onSensorChanged(e: SensorEvent) {
        val now = System.currentTimeMillis()
        if (now - lastEventMs < 3000 || mph < 10) return // debounce; ignore while parked
        val mag = sqrt((e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]).toDouble())
        when (e.sensor.type) {
            Sensor.TYPE_LINEAR_ACCELERATION -> if (mag > HARD_BRAKE_MS2) { lastEventMs = now; onEvent(DriverEvent.HARD_BRAKE) }
            Sensor.TYPE_GYROSCOPE -> if (mag > SWERVE_RAD_S) { lastEventMs = now; onEvent(DriverEvent.SWERVE) }
        }
    }

    override fun onAccuracyChanged(s: Sensor?, accuracy: Int) {}

    companion object { const val HARD_BRAKE_MS2 = 4.0; const val SWERVE_RAD_S = 0.9 }
}
