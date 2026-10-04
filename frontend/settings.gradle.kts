pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        google(); mavenCentral()
        // Mapbox Maps SDK: no secret download token needed for 11.x. Limited to its own groups.
        maven {
            url = java.net.URI("https://api.mapbox.com/downloads/v2/releases/maven")
            content { includeGroupByRegex("com\\.mapbox(\\..*)?") }
        }
        maven { url = java.net.URI("https://maven.presagetech.com/releases") }
    }
}
rootProject.name = "driver-guardian"
include(":core", ":app")
