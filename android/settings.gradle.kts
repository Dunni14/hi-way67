pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Mapbox Maps SDK. No secret download token needed for current 11.x (see the Mapbox install guide).
        // Listed before Presage and limited to its own groups, so resolving Mapbox never waits on another host.
        maven {
            url = java.net.URI("https://api.mapbox.com/downloads/v2/releases/maven")
            content { includeGroupByRegex("com\\.mapbox(\\..*)?") }
        }
        maven { url = java.net.URI("https://maven.presagetech.com/releases") }
    }
}
rootProject.name = "coolvitals"
include(":app")
