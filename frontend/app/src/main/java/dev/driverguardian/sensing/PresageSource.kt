package dev.driverguardian.sensing

import android.content.Context
import android.util.Log
import androidx.camera.core.Preview
import androidx.lifecycle.Observer
import com.presagetech.smartspectra.CameraSelection
import com.presagetech.smartspectra.ProcessingStatus
import com.presagetech.smartspectra.SmartSpectraConfig
import com.presagetech.smartspectra.SmartSpectraError
import com.presagetech.smartspectra.SmartSpectraException
import com.presagetech.smartspectra.SmartSpectraSdk
import com.presagetech.smartspectra.ValidationCode
import com.presagetech.smartspectra.ValidationStatus
import com.presagetech.smartspectra.proto.MetricsProto
import dev.driverguardian.BuildConfig
import dg.core.DemoScript
import dg.core.FaceSampler
import dg.core.PresageFrame
import dg.core.RealClock
import dg.core.TripClock
import dg.core.Pt
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** ~1 Hz driver signals. [SmartSpectraPresageSource] wraps the Presage SmartSpectra SDK. */
interface PresageSource {
    fun frames(tripStartMs: Long): Flow<PresageFrame>
}

/**
 * Replays [DemoScript] so the pipeline and the demo run without the SDK or a face. Emits one frame
 * per second of script time, paced in real time by [clock] and stamped with script time.
 */
class FakePresageSource(private val clock: TripClock = RealClock) : PresageSource {
    override fun frames(tripStartMs: Long): Flow<PresageFrame> = flow {
        var scriptMs = 0L
        while (true) {
            scriptMs += 1000
            val wait = tripStartMs + clock.realMs(scriptMs) - System.currentTimeMillis()
            if (wait > 0) delay(wait)
            emit(DemoScript.frame(tripStartMs + scriptMs, scriptMs / 1000.0))
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
 * second built from the latest SDK metrics: pulse, breathing, blinks and expression scores from the
 * SDK, plus eye closure and yawns derived from every face-landmark frame ([FaceSampler]). Nod and gaze
 * stay at their defaults.
 */
class SmartSpectraPresageSource(private val context: Context) : PresageSource {
    override fun frames(tripStartMs: Long): Flow<PresageFrame> = flow {
        // The dashcam view hands over its preview surface; give it a moment so the SDK has somewhere to draw.
        val surface = withTimeoutOrNull(3_000) { PresagePreview.surface.first { it != null } }
        if (surface == null) Log.w(TAG, "no preview surface; running without preview")
        val config = SmartSpectraConfig().apply {
            apiKey = BuildConfig.PRESAGE_API_KEY
            surface?.let { previewSurfaceProvider = it }
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
        // Every landmark sample goes through the sampler as it arrives (each update is a batch of
        // camera frames); the 1 Hz loop below drains a per-second summary from it.
        val sampler = FaceSampler()
        var loggedUnit = false
        val metricsObs = Observer<MetricsProto.Metrics?> { m ->
            metrics = m
            val face = m?.takeIf { it.hasFace() }?.face ?: return@Observer
            for (lm in face.landmarksList) {
                // Fall back to arrival time if the SDK leaves the timestamp unset.
                val ts = lm.timestamp.takeIf { it > 0 } ?: (System.currentTimeMillis() * 1000)
                sampler.add(ts, lm.valueList.map { Pt(it.x.toDouble(), it.y.toDouble()) })
            }
            if (!loggedUnit && sampler.unitsPerMs != null) {
                loggedUnit = true
                Log.d(TAG, "landmark timestamps: ${sampler.unitsPerMs} units/ms, ${face.landmarksList.lastOrNull()?.valueCount} points")
            }
        }
        val validationObs = Observer<ValidationStatus?> { s ->
            s ?: return@Observer
            if ((s.code == ValidationCode.OK) != valid) Log.d(TAG, "validation ${s.code} ${s.hint}")
            valid = s.code == ValidationCode.OK
        }
        val statusObs = Observer<ProcessingStatus?> { Log.d(TAG, "processing $it") }
        val errorObs = Observer<SmartSpectraError?> { e -> e?.let { Log.e(TAG, "error ${it.code}: ${it.message}") } }
        sdk.metrics.observeForever(metricsObs)
        sdk.validationStatus.observeForever(validationObs)
        sdk.processingStatus.observeForever(statusObs)
        sdk.error.observeForever(errorObs)
        try {
            coroutineScope {
                // Like Presage's samples: start in its own coroutine so the 1 Hz loop runs either way.
                launch {
                    try { sdk.start() } catch (e: SmartSpectraException) { Log.e(TAG, "start failed ${e.error.code}: ${e.error.message}") }
                }
                while (true) {
                    delay(1000)
                    val now = System.currentTimeMillis()
                    val m = metrics
                    val face = m?.takeIf { it.hasFace() }?.face
                    val pulse = m?.cardio?.pulseRateList?.lastOrNull()
                    val rate = m?.breathing?.rateList?.lastOrNull()
                    val blinking = face?.blinkingList?.lastOrNull()?.detected == true
                    if (blinking) { if (blinkSinceMs == null) blinkSinceMs = now } else blinkSinceMs = null
                    val scores = face?.expressionList?.lastOrNull()?.scoresList.orEmpty()
                    fun score(t: MetricsProto.ExpressionType) = scores.firstOrNull { it.type == t }?.confidence?.toDouble() ?: 0.0

                    val talking = face?.talkingList?.lastOrNull()?.detected
                    val f = sampler.drain()
                    // Mean eye closure over this second's frames when landmarks came in, else the blink flag.
                    val eyeClosed = f.eyeClosed
                        ?: if (face != null && face.blinkingCount > 0) (if (blinking) 1.0 else 0.0) else null
                    // One line per second for tuning: watch mouth while yawning vs talking.
                    Log.d(TAG, "face: frames=${f.samples} eyeClosed=${fmt(eyeClosed)} mouthMax=${fmt(f.mouthOpenMax)} " +
                        "talking=$talking blink=$blinking valid=$valid" + if (f.yawned) "  >>> YAWN (${sampler.totalYawns} this trip)" else "")

                    emit(PresageFrame(
                        tsMs = now,
                        // Face visibility comes from the SDK's validation, not from pulse quality.
                        confidence = if (valid && m != null) 1.0 else 0.0,
                        eyeClosed = eyeClosed,
                        longBlink = blinkSinceMs?.let { now - it >= LONG_BLINK_MS } == true,
                        yawn = f.yawned,
                        heartRate = pulse?.takeIf { it.confidence.toDouble() >= MIN_PULSE_CONFIDENCE }?.value?.toDouble(),
                        breathing = rate?.value?.toDouble(),
                        stress = if (scores.isEmpty()) null else maxOf(score(MetricsProto.ExpressionType.ANGRY), score(MetricsProto.ExpressionType.FEAR), score(MetricsProto.ExpressionType.DISGUST)),
                        talking = talking,
                        mouthOpen = f.mouthOpenMax,
                    ))
                }
            }
        } finally {
            sdk.metrics.removeObserver(metricsObs)
            sdk.validationStatus.removeObserver(validationObs)
            sdk.processingStatus.removeObserver(statusObs)
            sdk.error.removeObserver(errorObs)
            withContext(NonCancellable) { sdk.stop() }
        }
    }

    private companion object {
        const val TAG = "Presage"
        const val LONG_BLINK_MS = 500L
        fun fmt(v: Double?) = v?.let { "%.2f".format(it) } ?: "-"
        const val MIN_PULSE_CONFIDENCE = 0.5
    }
}
