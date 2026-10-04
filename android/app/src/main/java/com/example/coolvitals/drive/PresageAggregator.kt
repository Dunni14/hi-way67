package com.example.coolvitals.drive

import kotlin.math.max
import kotlin.math.min

/** One face-detection sample from the SDK (`Face.blinking`): `detected` is the SDK's flag, `ts` its raw timestamp. */
data class BlinkSample(val ts: Long, val detected: Boolean)

/** Below this Presage confidence a vital is dropped (the README's "drop low-confidence frames"). Hand-set. */
const val MIN_VITAL_CONFIDENCE = 0.5f
/** A heart or breathing rate older than this is no longer evidence. Hand-set. */
const val VITAL_STALE_MS = 20_000L
/** No metrics for this long means the face is not being read. */
const val FACE_STALE_MS = 5_000L

/**
 * `longest_eye_closure_s` drives the backend's microsleep override (tier 3, guardians notified), so it must
 * be right before it is sent. The SDK's blink flags have no documented timestamp unit or "eye closed" meaning,
 * so this stays off until it has been checked against a real face on a device (docs/drive-screen.md).
 */
const val SEND_LONGEST_CLOSURE = false

/** Expressions that count towards `emotion_stress`. Hand-set. */
private val STRESS_EXPRESSIONS = setOf("ANGRY", "FEAR", "DISGUST", "SAD")

/**
 * Turns Presage SDK output into the backend's `SignalWindow` fields for one 10 s window. Pure: the SDK wrapper
 * ([PresageSource]) feeds it plain values, so every rule here runs as a JVM unit test. Fields it cannot derive
 * (yawns, engagement, gaze, phone in hand, hard brakes) are left out, which the engine reads as "no evidence".
 *
 * Thread-safe: the SDK calls from the main thread, the session reads from a coroutine.
 */
class PresageAggregator(private val now: () -> Long = System::currentTimeMillis) {
    private var pulse: Pair<Float, Long>? = null // value, wall time
    private var breathing: Pair<Float, Long>? = null
    private var blinks = ArrayList<BlinkSample>()
    private var lastBlinkTs = Long.MIN_VALUE
    private var stress: Float? = null
    private var validationOk = false
    private var lastFrameMs: Long? = null

    /** Any metrics message arrived: the face pipeline is alive. */
    @Synchronized fun onFrame() {
        lastFrameMs = now()
    }

    @Synchronized fun onPulse(value: Float, confidence: Float) {
        if (confidence >= MIN_VITAL_CONFIDENCE && value > 0f) pulse = value to now()
    }

    @Synchronized fun onBreathing(value: Float, confidence: Float) {
        if (confidence >= MIN_VITAL_CONFIDENCE && value > 0f) breathing = value to now()
    }

    /** Pass the SDK's whole list each time: entries already seen (by timestamp) are skipped. */
    @Synchronized fun onBlinks(all: List<BlinkSample>) {
        for (b in all) if (b.ts > lastBlinkTs) {
            blinks.add(b)
            lastBlinkTs = b.ts
        }
    }

    /** Latest expression scores by name (`ANGRY`, `HAPPY`, ...), each 0..1. */
    @Synchronized fun onExpression(scores: Map<String, Float>) {
        stress = min(1f, max(0f, scores.filterKeys { it in STRESS_EXPRESSIONS }.values.sum()))
    }

    @Synchronized fun onValidation(ok: Boolean) {
        validationOk = ok
    }

    /** Fields for the window that just closed. Per-window state (blinks) resets; slow vitals carry over until stale. */
    @Synchronized fun snapshot(): Map<String, Any?> {
        val t = now()
        val out = LinkedHashMap<String, Any?>()
        val faceVisible = validationOk && lastFrameMs?.let { t - it <= FACE_STALE_MS } == true
        out["face_visible"] = faceVisible
        if (faceVisible) {
            pulse?.takeIf { t - it.second <= VITAL_STALE_MS }?.let { out["heart_rate"] = it.first.toDouble() }
            breathing?.takeIf { t - it.second <= VITAL_STALE_MS }?.let { out["breathing_rate"] = it.first.toDouble() }
            if (blinks.isNotEmpty()) out["eye_closure_frac"] = blinks.count { it.detected }.toDouble() / blinks.size
            stress?.let { out["emotion_stress"] = it.toDouble() }
        }
        blinks = ArrayList()
        return out
    }
}
