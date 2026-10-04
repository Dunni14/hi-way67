package dev.driverguardian.sensing

import android.content.Context
import androidx.camera.core.Preview
import androidx.lifecycle.Observer
import com.presagetech.smartspectra.CameraSelection
import com.presagetech.smartspectra.SmartSpectraConfig
import com.presagetech.smartspectra.SmartSpectraException
import com.presagetech.smartspectra.SmartSpectraSdk
import com.presagetech.smartspectra.ValidationCode
import com.presagetech.smartspectra.proto.MetricsProto
import dev.driverguardian.BuildConfig
import dg.core.DemoScript
import dg.core.PresageFrame
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext

/** ~1 Hz driver signals. [SmartSpectraPresageSource] wraps the Presage SmartSpectra SDK. */
interface PresageSource {
    fun frames(tripStartMs: Long): Flow<PresageFrame>
}

/** Replays [DemoScript] so the pipeline and the demo run without the SDK or a face. */
class FakePresageSource : PresageSource {
    override fun frames(tripStartMs: Long): Flow<PresageFrame> = flow {
        while (true) {
            val now = System.currentTimeMillis()
            emit(DemoScript.frame(now, (now - tripStartMs) / 1000.0))
            delay(1000)
        }
    }
}

/**
 * The SmartSpectra SDK owns the front camera while a trip runs, so the dashcam preview hands its
 * surface here instead of binding CameraX itself (see `CameraPreview`).
 */
object PresagePreview {
    val surface = MutableStateFlow<Preview.SurfaceProvider?>(null)
}

/**
 * Real Presage source (SDK usage mirrors the standalone demo in `../android`). Emits one frame per
 * second built from the latest SDK metrics. The SDK exposes pulse, breathing, blinks and expression
 * scores; it has no eye-closure ratio, yawn, nod or gaze output, so those stay at their defaults and
 * the risk model leans on blinks, vitals and the phone's IMU instead.
 */
class SmartSpectraPresageSource(private val context: Context) : PresageSource {
    override fun frames(tripStartMs: Long): Flow<PresageFrame> = flow {
        val config = SmartSpectraConfig().apply {
            apiKey = BuildConfig.PRESAGE_API_KEY
            PresagePreview.surface.value?.let { previewSurfaceProvider = it }
            // SDK default is breathing only; everything else has to be requested.
            requestedMetrics = SmartSpectraConfig.cardioMetrics +
                SmartSpectraConfig.breathingMetrics +
                SmartSpectraConfig.faceMetrics
        }
        val sdk = SmartSpectraSdk.initialize(context, config)
        sdk.useCamera(CameraSelection.Front)

        var metrics: MetricsProto.Metrics? = null
        var valid = false
        var blinkSinceMs: Long? = null
        val metricsObs = Observer<MetricsProto.Metrics?> { metrics = it }
        val validationObs = Observer<com.presagetech.smartspectra.ValidationStatus?> { it?.let { s -> valid = s.code == ValidationCode.OK } }
        sdk.metrics.observeForever(metricsObs)
        sdk.validationStatus.observeForever(validationObs)
        try {
            try { sdk.start() } catch (e: SmartSpectraException) { android.util.Log.e("Presage", "start failed ${e.error.code}: ${e.error.message}"); return@flow }
            while (true) {
                delay(1000)
                val now = System.currentTimeMillis()
                val m = metrics
                val pulse = m?.cardio?.pulseRateList?.lastOrNull()
                val rate = m?.breathing?.rateList?.lastOrNull()
                val blinking = m?.face?.blinkingList?.lastOrNull()?.detected == true
                if (blinking) { if (blinkSinceMs == null) blinkSinceMs = now } else blinkSinceMs = null
                val scores = m?.face?.expressionList?.lastOrNull()?.scoresList.orEmpty()
                fun score(t: MetricsProto.ExpressionType) = scores.firstOrNull { it.type == t }?.confidence?.toDouble() ?: 0.0
                emit(PresageFrame(
                    tsMs = now,
                    confidence = if (valid && m != null) (pulse?.confidence?.toDouble() ?: 1.0) else 0.0,
                    eyeClosed = if (m?.face?.blinkingCount?.let { it > 0 } == true) (if (blinking) 1.0 else 0.0) else null,
                    longBlink = blinkSinceMs?.let { now - it >= LONG_BLINK_MS } == true,
                    heartRate = pulse?.value?.toDouble(),
                    breathing = rate?.value?.toDouble(),
                    stress = if (scores.isEmpty()) null else maxOf(score(MetricsProto.ExpressionType.ANGRY), score(MetricsProto.ExpressionType.FEAR), score(MetricsProto.ExpressionType.DISGUST)),
                ))
            }
        } finally {
            sdk.metrics.removeObserver(metricsObs)
            sdk.validationStatus.removeObserver(validationObs)
            withContext(NonCancellable) { sdk.stop() }
        }
    }

    private companion object { const val LONG_BLINK_MS = 500L }
}
