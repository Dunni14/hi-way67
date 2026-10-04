package com.example.coolvitals.drive

import android.content.Context
import android.util.Log
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import com.presagetech.smartspectra.CameraSelection
import com.presagetech.smartspectra.SmartSpectraConfig
import com.presagetech.smartspectra.SmartSpectraException
import com.presagetech.smartspectra.SmartSpectraSdk
import com.presagetech.smartspectra.ValidationCode
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The Presage SmartSpectra SDK inside the Drive screen: front camera into a small preview, metrics into the
 * [PresageAggregator]. Thin on purpose (the SDK needs a camera and native code, so it cannot run in a JVM
 * test); every mapping rule lives in the aggregator.
 *
 * One camera owner at a time: the SDK is a process singleton, so this must not run while `MainActivity` has it.
 */
class PresageSource(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val preview: PreviewView,
    private val aggregator: PresageAggregator,
    private val apiKey: String,
    /** Hint for the driver ("Face not visible", an error), or null when all is well. */
    private val onStatus: (String?) -> Unit,
) {
    private var sdk: SmartSpectraSdk? = null
    private var started = false

    fun start() {
        if (started || apiKey.isBlank()) {
            if (apiKey.isBlank()) onStatus("Presage key missing")
            return
        }
        started = true
        val config = SmartSpectraConfig().apply {
            apiKey = this@PresageSource.apiKey
            previewSurfaceProvider = preview.surfaceProvider
            // SDK default is breathing only; everything else has to be requested.
            requestedMetrics = SmartSpectraConfig.cardioMetrics + SmartSpectraConfig.breathingMetrics + SmartSpectraConfig.faceMetrics
        }
        val s = SmartSpectraSdk.initialize(context.applicationContext, config)
        sdk = s
        s.useCamera(CameraSelection.Front)

        s.metrics.observe(owner) { m ->
            m ?: return@observe
            aggregator.onFrame()
            m.cardio.pulseRateList.lastOrNull()?.let { aggregator.onPulse(it.value, it.confidence) }
            m.breathing.rateList.lastOrNull()?.let { aggregator.onBreathing(it.value, it.confidence) }
            aggregator.onBlinks(m.face.blinkingList.map { BlinkSample(it.timestamp, it.detected) })
            m.face.expressionList.lastOrNull()?.let { e -> aggregator.onExpression(e.scoresList.associate { it.type.name to it.confidence }) }
        }
        s.validationStatus.observe(owner) { status ->
            status ?: return@observe
            val ok = status.code == ValidationCode.OK
            aggregator.onValidation(ok)
            onStatus(if (ok) null else status.hint.ifBlank { status.code.name })
        }
        s.error.observe(owner) { error ->
            error ?: return@observe
            Log.e(TAG, "Error ${error.code}: ${error.message}")
            onStatus("Presage: ${error.message}")
        }
        owner.lifecycleScope.launch {
            try {
                s.start()
            } catch (e: SmartSpectraException) {
                Log.e(TAG, "Start failed ${e.error.code}: ${e.error.message}")
                onStatus("Presage: ${e.error.message}")
            }
        }
    }

    /** Releases the camera. Safe to call when never started. */
    fun stop() {
        val s = sdk ?: return
        sdk = null
        started = false
        aggregator.onValidation(false) // no face while the camera is off
        owner.lifecycleScope.launch(NonCancellable) { withContext(NonCancellable) { s.stop() } }
    }

    private companion object {
        const val TAG = "PresageSource"
    }
}
