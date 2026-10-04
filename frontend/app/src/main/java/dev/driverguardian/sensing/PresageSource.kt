package dev.driverguardian.sensing

import dg.core.DemoScript
import dg.core.PresageFrame
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** ~1 Hz driver signals. The real implementation wraps the Presage Android SDK on the CameraX feed. */
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

/** Placeholder until the Presage SDK is added: no frames, so the app reports "Can't see driver". */
class NoPresageSource : PresageSource {
    override fun frames(tripStartMs: Long): Flow<PresageFrame> = flow { while (true) delay(60_000) }
}
