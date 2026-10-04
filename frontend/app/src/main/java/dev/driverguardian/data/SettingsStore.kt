package dev.driverguardian.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.driverguardian.BuildConfig
import dg.core.SharingMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.store by preferencesDataStore("settings")

data class AppSettings(
    val sharingMode: SharingMode = SharingMode.HIGH_ONLY,
    val kidsInCar: Boolean = false,
    val driverName: String = "",
    val host: String = BuildConfig.BACKEND_HOST,
    /** Replay scripted Presage signals (the real Presage SDK is not wired in yet). */
    val demoMode: Boolean = true,
    /** Stable id for the engine's per-driver weights and trip history. Generated on first run. */
    val driverId: String = "",
    /** Score on the backend risk engine (REST). Off, or engine unavailable: the phone scores locally. */
    val useEngine: Boolean = true,
    val lowExperience: Boolean = false,
    /** Hours slept last night, optional. Null = not given. */
    val sleepHours: Double? = null,
)

class SettingsStore(private val context: Context) {
    private val kSharing = stringPreferencesKey("sharing")
    private val kKids = booleanPreferencesKey("kids")
    private val kName = stringPreferencesKey("name")
    private val kHost = stringPreferencesKey("host")
    private val kDemo = booleanPreferencesKey("demo")
    private val kDriverId = stringPreferencesKey("driver_id")
    private val kEngine = booleanPreferencesKey("engine")
    private val kLowExp = booleanPreferencesKey("low_exp")
    private val kSleep = doublePreferencesKey("sleep_hours")

    val flow: Flow<AppSettings> = context.store.data.map { p ->
        AppSettings(
            sharingMode = runCatching { SharingMode.valueOf(p[kSharing] ?: "") }.getOrDefault(SharingMode.HIGH_ONLY),
            kidsInCar = p[kKids] ?: false,
            driverName = p[kName] ?: "",
            host = p[kHost] ?: BuildConfig.BACKEND_HOST,
            demoMode = p[kDemo] ?: true,
            driverId = p[kDriverId] ?: "",
            useEngine = p[kEngine] ?: true,
            lowExperience = p[kLowExp] ?: false,
            sleepHours = p[kSleep],
        )
    }

    suspend fun update(s: AppSettings) {
        context.store.edit {
            it[kSharing] = s.sharingMode.name
            it[kKids] = s.kidsInCar
            it[kName] = s.driverName
            it[kHost] = s.host.trim()
            it[kDemo] = s.demoMode
            it[kDriverId] = s.driverId
            it[kEngine] = s.useEngine
            it[kLowExp] = s.lowExperience
            if (s.sleepHours != null) it[kSleep] = s.sleepHours else it.remove(kSleep)
        }
    }
}
