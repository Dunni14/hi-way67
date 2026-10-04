package com.example.coolvitals

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.presagetech.smartspectra.CameraSelection
import com.presagetech.smartspectra.SmartSpectraConfig
import com.presagetech.smartspectra.SmartSpectraException
import com.presagetech.smartspectra.SmartSpectraSdk
import com.presagetech.smartspectra.ValidationCode
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var statusTextView: TextView
    private var smartSpectra: SmartSpectraSdk? = null
    private var hasReading = false

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            startSmartSpectra()
        } else {
            statusTextView.text = "Camera permission is required."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        previewView = findViewById(R.id.previewView)
        statusTextView = findViewById(R.id.statusTextView)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startSmartSpectra()
        } else {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startSmartSpectra() {
        val config = SmartSpectraConfig().apply {
            apiKey = BuildConfig.PRESAGE_API_KEY
            previewSurfaceProvider = previewView.surfaceProvider
            // SDK default is breathing only; everything else has to be requested.
            requestedMetrics = SmartSpectraConfig.cardioMetrics +
                SmartSpectraConfig.breathingMetrics +
                SmartSpectraConfig.faceMetrics
        }

        val sdk = SmartSpectraSdk.initialize(applicationContext, config)
        smartSpectra = sdk
        sdk.useCamera(CameraSelection.Front)

        sdk.metrics.observe(this) { metrics ->
            val pulse = metrics?.cardio?.pulseRateList?.lastOrNull() ?: return@observe
            hasReading = true
            statusTextView.text = "Heart Rate: ${pulse.value.toInt()} bpm\nConfidence: ${pulse.confidence}"
            Log.d(TAG, "HR: ${pulse.value}, Confidence: ${pulse.confidence}")
        }

        sdk.validationStatus.observe(this) { status ->
            status ?: return@observe
            Log.d(TAG, "Validation: ${status.code} ${status.hint}")
            if (status.code != ValidationCode.OK) {
                hasReading = false
                statusTextView.text = status.hint.ifBlank { status.code.name }
            } else if (!hasReading) {
                statusTextView.text = "Hold still, measuring..."
            }
        }

        sdk.processingStatus.observe(this) { status ->
            Log.d(TAG, "Status: $status")
        }

        sdk.error.observe(this) { error ->
            error ?: return@observe
            statusTextView.text = "Error: ${error.message}"
            Log.e(TAG, "Error ${error.code}: ${error.message}")
        }

        lifecycleScope.launch {
            try {
                sdk.start()
            } catch (e: SmartSpectraException) {
                statusTextView.text = "Error: ${e.error.message}"
                Log.e(TAG, "Start failed ${e.error.code}: ${e.error.message}")
            }
        }
    }

    override fun onDestroy() {
        val sdk = smartSpectra
        if (sdk != null) {
            lifecycleScope.launch(NonCancellable) {
                withContext(NonCancellable) { sdk.stop() }
            }
        }
        super.onDestroy()
    }

    private companion object {
        const val TAG = "SmartSpectra"
    }
}
