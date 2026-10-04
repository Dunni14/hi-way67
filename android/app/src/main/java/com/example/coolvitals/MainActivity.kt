package com.example.coolvitals

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.PointF
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
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
import com.presagetech.smartspectra.proto.MetricsProto.ExpressionType
import com.presagetech.smartspectra.proto.MetricsProto.Metrics
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var statusTextView: TextView
    private lateinit var hudTextView: TextView
    private lateinit var faceMeshView: FaceMeshView
    private lateinit var heartRateGraph: SparklineView
    private var smartSpectra: SmartSpectraSdk? = null
    private var hasReading = false

    // Latest values shown in the HUD. Null = not reported yet.
    private val faceStats = FaceStats()
    private var heartRate: Float? = null
    private var heartRateConfidence: Float? = null
    private var blinking: Boolean? = null
    private var talking: Boolean? = null
    private var expression: String? = null
    private var expressionConfidence = 0f
    private var eyeOpenness: Float? = null
    private var mouthOpenness: Float? = null
    private var landmarkCount = 0

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
        hudTextView = findViewById(R.id.hudTextView)
        faceMeshView = findViewById(R.id.faceMeshView)
        heartRateGraph = findViewById(R.id.heartRateGraph)
        heartRateGraph.label = "Heart rate (bpm, 60 s)"
        renderHud()

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
            metrics ?: return@observe
            updateCardio(metrics)
            updateFace(metrics)
            renderHud()
        }

        sdk.validationStatus.observe(this) { status ->
            status ?: return@observe
            Log.d(TAG, "Validation: ${status.code} ${status.hint}")
            if (status.code != ValidationCode.OK) {
                hasReading = false
                faceMeshView.clear()
                statusTextView.visibility = View.VISIBLE
                statusTextView.text = status.hint.ifBlank { status.code.name }
            } else if (!hasReading) {
                statusTextView.visibility = View.VISIBLE
                statusTextView.text = "Hold still, measuring..."
            }
        }

        sdk.processingStatus.observe(this) { status ->
            Log.d(TAG, "Status: $status")
        }

        sdk.error.observe(this) { error ->
            error ?: return@observe
            statusTextView.visibility = View.VISIBLE
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

    private fun updateCardio(metrics: Metrics) {
        val pulse = metrics.cardio.pulseRateList.lastOrNull() ?: return
        heartRate = pulse.value.toFloat()
        heartRateConfidence = pulse.confidence.toFloat()
        heartRateGraph.add(pulse.value.toFloat())
        hasReading = true
        statusTextView.visibility = View.GONE
        Log.d(TAG, "HR: ${pulse.value}, Confidence: ${pulse.confidence}")
    }

    private fun updateFace(metrics: Metrics) {
        if (!metrics.hasFace()) return
        val face = metrics.face
        val now = SystemClock.elapsedRealtime()

        if (face.blinkingCount > 0) {
            face.blinkingList.forEach { faceStats.addBlinking(it.detected, now) }
            blinking = face.blinkingList.last().detected
        }
        if (face.talkingCount > 0) {
            talking = face.talkingList.last().detected
        }

        // Keep the last valid expression so the label doesn't flicker.
        val topScore = face.expressionList.lastOrNull()?.scoresList
            ?.filter { it.confidence > 0 }
            ?.maxByOrNull { it.confidence }
        val name = topScore?.type?.let(::expressionName)
        if (topScore != null && name != null) {
            expression = name
            expressionConfidence = topScore.confidence
        }

        val landmarks = face.landmarksList.lastOrNull()
        if (landmarks != null && landmarks.valueCount > 0) {
            val points = landmarks.valueList.map { PointF(it.x.toFloat(), it.y.toFloat()) }
            landmarkCount = points.size
            eyeOpenness = FaceGeometry.eyeOpenness(points)
            mouthOpenness = FaceGeometry.mouthOpenness(points)
            faceMeshView.setLandmarks(points, landmarks.stable)
        }
    }

    private fun renderHud() {
        val lines = listOf(
            "Heart   " + (heartRate?.let { fmt("%.0f bpm (conf %.2f)", it, heartRateConfidence ?: 0f) } ?: "--"),
            "Eyes    " + when (blinking) {
                true -> "CLOSED"
                false -> "open"
                null -> "--"
            } + fmt("   closed %.0f%% /60s", faceStats.eyesClosedFraction * 100),
            "Blinks  ${faceStats.blinksPerMinute}/min",
            "Talking " + when (talking) {
                true -> "yes"
                false -> "no"
                null -> "--"
            },
            "Mood    " + (expression?.let { fmt("%s %.0f%%", it, expressionConfidence) } ?: "--"),
            "EAR     " + (eyeOpenness?.let { fmt("%.2f", it) } ?: "--") +
                "   Mouth " + (mouthOpenness?.let { fmt("%.2f", it) } ?: "--"),
            "Mesh    $landmarkCount pts",
        )
        hudTextView.text = lines.joinToString("\n")
    }

    private fun expressionName(type: ExpressionType): String? = when (type) {
        ExpressionType.ANGRY -> "Angry"
        ExpressionType.CONTEMPT -> "Contempt"
        ExpressionType.DISGUST -> "Disgust"
        ExpressionType.FEAR -> "Fear"
        ExpressionType.HAPPY -> "Happy"
        ExpressionType.NEUTRAL -> "Neutral"
        ExpressionType.SAD -> "Sad"
        ExpressionType.SURPRISE -> "Surprise"
        else -> null
    }

    private fun fmt(format: String, vararg args: Any): String = String.format(Locale.ROOT, format, *args)

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
