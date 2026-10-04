package dev.driverguardian.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
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
)

class SettingsStore(private val context: Context) {
    private val kSharing = stringPreferencesKey("sharing")
    private val kKids = booleanPreferencesKey("kids")
    private val kName = stringPreferencesKey("name")
    private val kHost = stringPreferencesKey("host")
    private val kDemo = booleanPreferencesKey("demo")

    val flow: Flow<AppSettings> = context.store.data.map { p ->
        AppSettings(
            sharingMode = runCatching { SharingMode.valueOf(p[kSharing] ?: "") }.getOrDefault(SharingMode.HIGH_ONLY),
            kidsInCar = p[kKids] ?: false,
            driverName = p[kName] ?: "",
            host = p[kHost] ?: BuildConfig.BACKEND_HOST,
            demoMode = p[kDemo] ?: true,
        )
    }

    suspend fun update(s: AppSettings) {
        context.store.edit {
            it[kSharing] = s.sharingMode.name
            it[kKids] = s.kidsInCar
            it[kName] = s.driverName
            it[kHost] = s.host.trim()
            it[kDemo] = s.demoMode
        }
    }
}
