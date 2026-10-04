import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// PRESAGE_API_KEY lives in local.properties (not committed), same as ../android.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "dev.driverguardian"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.driverguardian"
        minSdk = 28 // Presage SmartSpectra SDK requires 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
        // host:port of the backend (no secrets here). Emulator -> host machine is 10.0.2.2.
        buildConfigField("String", "BACKEND_HOST", "\"10.0.2.2:8787\"")
        buildConfigField("String", "PRESAGE_API_KEY", "\"${localProperties.getProperty("PRESAGE_API_KEY", "")}\"")
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation(project(":core"))
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-extended") // Stats tile icons from the mockup
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.google.guava:guava:33.3.1-android") // ListenableFuture for CameraX
    implementation("com.presagetech:smartspectra:3.4.0")
    implementation("com.mapbox.maps:android-ndk27:11.32.0") // -ndk27: 16 KB page size support, needed at targetSdk 36
}
