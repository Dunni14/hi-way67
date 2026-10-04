import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// PRESAGE_API_KEY lives in local.properties (not committed).
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.example.coolvitals"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.example.coolvitals"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField(
            "String",
            "PRESAGE_API_KEY",
            "\"${localProperties.getProperty("PRESAGE_API_KEY", "")}\""
        )
        // Drive screen backend. Defaults reach a backend on the dev machine from the emulator; on a phone
        // set BACKEND_URL to the laptop's LAN IP (or an HTTPS tunnel) in local.properties.
        buildConfigField("String", "BACKEND_URL", "\"${localProperties.getProperty("BACKEND_URL", "http://10.0.2.2:8787")}\"")
        buildConfigField("String", "DRIVER_ID", "\"${localProperties.getProperty("DRIVER_ID", "demo")}\"")
        buildConfigField("boolean", "SHARE_LOCATION", localProperties.getProperty("SHARE_LOCATION", "true"))
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true // Robolectric view tests
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.8.1")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.2")
    implementation("androidx.camera:camera-view:1.3.1")
    implementation("com.presagetech:smartspectra:3.4.0")

    // Drive screen
    implementation("com.mapbox.maps:android-ndk27:11.32.0") // -ndk27: 16 KB page size support, needed at targetSdk 36
    implementation("com.google.android.material:material:1.13.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.6.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.16")
    testImplementation("androidx.test:core-ktx:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
}
