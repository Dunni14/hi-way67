pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        google(); mavenCentral()
        maven { url = java.net.URI("https://maven.presagetech.com/releases") }
    }
}
rootProject.name = "driver-guardian"
include(":core", ":app")
