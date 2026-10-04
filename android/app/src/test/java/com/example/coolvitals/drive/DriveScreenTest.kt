package com.example.coolvitals.drive

import android.Manifest
import android.app.Application
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.example.coolvitals.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * View tests on the JVM (Robolectric). A real MapView needs native GL, so these run without a Mapbox token,
 * which is exactly the "no token" case: the map box shows an error. Gesture settings on a live MapView, the 3D
 * look and the puck can only be checked on a device.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-xhdpi")
class DriveScreenTest {

    private val app get() = ApplicationProvider.getApplicationContext<Application>()

    private fun launch(demo: Boolean = false, grant: Boolean = false): ActivityScenario<DriveActivity> {
        if (grant) shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        return ActivityScenario.launch(Intent(app, DriveActivity::class.java).putExtra(DriveActivity.EXTRA_DEMO, demo))
    }

    private fun color(res: Int) = ContextCompat.getColor(app, res)

    // 1. Permission denied: header says No GPS (and there is no speed)
    @Test fun permissionDeniedShowsNoGps() {
        launch().use { s ->
            s.onActivity {
                assertEquals("No GPS", it.findViewById<TextView>(R.id.pillTitle).text)
                assertEquals("--", it.findViewById<TextView>(R.id.speedText).text)
            }
        }
    }

    // 2. No Mapbox token: clear message in the map box, no crash, no MapView
    @Test fun noTokenShowsAnErrorInTheMapBox() {
        launch().use { s ->
            s.onActivity {
                assertEquals(View.VISIBLE, it.findViewById<View>(R.id.mapError).visibility)
                assertEquals(0, it.findViewById<FrameLayout>(R.id.mapContainer).childCount)
            }
        }
    }

    // 3. Static box is not clickable, a box with onClick is and fires
    @Test fun clickRules() {
        launch().use { s ->
            s.onActivity { a ->
                val staticBox = StatusBoxView(a).apply { bind(StatusBox("a", "A", Level.GREAT, R.drawable.ic_box_eyes)) }
                assertFalse(staticBox.isClickable)
                assertFalse(staticBox.isFocusable)

                var clicks = 0
                val live = StatusBoxView(a).apply { bind(StatusBox("b", "B", Level.GREAT, R.drawable.ic_box_eyes, onClick = { clicks++ })) }
                assertTrue(live.isClickable)
                assertTrue(live.isFocusable)
                live.performClick()
                assertEquals(1, clicks)
            }
        }
    }

    // 3b. A box can hold anything in the same frame
    @Test fun customContentReplacesTheBody() {
        launch().use { s ->
            s.onActivity { a ->
                val v = StatusBoxView(a).apply {
                    bind(StatusBox("c", "C", Level.BAD, R.drawable.ic_box_eyes, content = { ctx -> TextView(ctx).apply { text = "sparkline"; id = 4242 } }))
                }
                assertNotNull(v.findViewById<View>(4242))
                assertEquals(null, v.findViewById<View>(R.id.boxValue))
            }
        }
    }

    // 4. The four default boxes make two rows (six make three: see DriveLogicTest); the grid caps its height
    @Test fun fourBoxesTwoRows() {
        launch(demo = true).use { s ->
            s.onActivity { a ->
                val vm = ViewModelProvider(a)[DriveViewModel::class.java]
                assertEquals(4, vm.state.value.boxes.size)
                val grid = a.findViewById<LinearLayout>(R.id.statusGrid)
                assertEquals(2, grid.childCount)
                assertEquals(2, (grid.getChildAt(0) as ViewGroup).childCount)
            }
        }
    }

    @Test fun gridScrollCapsHeight() {
        launch(demo = true).use { s ->
            s.onActivity { a ->
                val scroll = a.findViewById<MaxHeightScrollView>(R.id.gridScroll)
                scroll.maxHeightPx = 150
                val spec = View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.AT_MOST)
                scroll.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), spec)
                assertTrue(scroll.measuredHeight <= 150)
                scroll.maxHeightPx = Int.MAX_VALUE
                scroll.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), spec)
                assertTrue(scroll.measuredHeight > 150)
            }
        }
    }

    // 5. GOOD to BAD switches the card to red (and text to white)
    @Test fun goodToBadTurnsTheCardRed() {
        launch().use { s ->
            s.onActivity { a ->
                val v = StatusBoxView(a)
                v.bind(StatusBox("x", "Eye Tracking", Level.GOOD, R.drawable.ic_box_eyes))
                assertEquals(color(R.color.drive_card), v.targetCardColor())
                assertEquals(color(R.color.drive_good), v.findViewById<TextView>(R.id.boxValue).currentTextColor)
                v.bind(StatusBox("x", "Eye Tracking", Level.BAD, R.drawable.ic_box_eyes))
                assertEquals(color(R.color.drive_bad), v.targetCardColor())
                assertEquals("BAD", v.findViewById<TextView>(R.id.boxValue).text)
            }
        }
    }

    @Test fun levelColors() {
        launch().use { s ->
            s.onActivity { a ->
                val v = StatusBoxView(a)
                v.bind(StatusBox("x", "L", Level.GREAT, R.drawable.ic_box_eyes))
                assertEquals(color(R.color.drive_great), v.findViewById<TextView>(R.id.boxValue).currentTextColor)
                v.bind(StatusBox("x", "L", Level.OK, R.drawable.ic_box_eyes))
                v.bind(StatusBox("x", "L", Level.OK, R.drawable.ic_box_eyes))
                assertEquals(color(R.color.drive_card), v.targetCardColor()) // OK stays on a white card
            }
        }
    }

    // 6. limit_source none shows "--"; fallback shows a dot
    @Test fun limitDisplay() {
        launch(demo = true).use { s ->
            s.onActivity { a ->
                val vm = ViewModelProvider(a)[DriveViewModel::class.java]
                assertEquals("55", a.findViewById<TextView>(R.id.limitText).text)
                assertEquals(View.GONE, a.findViewById<View>(R.id.limitFallbackDot).visibility)
                vm.onWindowResult(WindowResult(0, emptyMap(), false, 45, LimitSource.FALLBACK))
                assertEquals(View.VISIBLE, a.findViewById<View>(R.id.limitFallbackDot).visibility)
                vm.onWindowResult(WindowResult(0, emptyMap(), false, null, LimitSource.NONE))
                assertEquals("--", a.findViewById<TextView>(R.id.limitText).text)
            }
        }
    }

    @Test fun speedColorFollowsTheLimit() {
        launch(demo = true).use { s ->
            s.onActivity { a ->
                val vm = ViewModelProvider(a)[DriveViewModel::class.java]
                val speed = a.findViewById<TextView>(R.id.speedText)
                assertEquals("52", speed.text) // demo: 52 mph on a 55 road
                assertEquals(color(R.color.drive_great), speed.currentTextColor)
                vm.onWindowResult(WindowResult(0, emptyMap(), false, 45, LimitSource.OSM))
                assertEquals(color(R.color.drive_speed_over), speed.currentTextColor)
            }
        }
    }

    @Test fun alertBannerFollowsTheTier() {
        launch(demo = true).use { s ->
            s.onActivity { a ->
                val vm = ViewModelProvider(a)[DriveViewModel::class.java]
                val banner = a.findViewById<View>(R.id.alertBanner)
                vm.onWindowResult(WindowResult(0, emptyMap(), false, 55, LimitSource.OSM))
                assertEquals(View.GONE, banner.visibility)
                vm.onWindowResult(WindowResult(3, emptyMap(), false, 55, LimitSource.OSM))
                assertEquals(View.VISIBLE, banner.visibility)
                assertEquals("Pull over now", (banner as TextView).text)
            }
        }
    }

    // 7. Gestures are off by default (the live gesture settings need a device)
    @Test fun mapIsNotInteractiveByDefault() {
        launch().use { s -> s.onActivity { assertFalse(it.mapInteractive) } }
    }

    // 8. 360 dp wide: nothing in the header is pushed outside the screen
    @Test fun headerFitsAt360dp() {
        launch(demo = true).use { s ->
            s.onActivity { a ->
                val root = a.findViewById<View>(R.id.driveRoot)
                root.measure(View.MeasureSpec.makeMeasureSpec(720, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1280, View.MeasureSpec.EXACTLY))
                root.layout(0, 0, 720, 1280)
                val limit = a.findViewById<View>(R.id.limitCard)
                val pill = a.findViewById<View>(R.id.statusPill)
                val speed = a.findViewById<View>(R.id.speedText)
                val header = a.findViewById<View>(R.id.driveHeader)
                fun right(v: View): Int { var x = v.right; var p = v.parent; while (p is View && p !== header) { x += (p as View).left; p = p.parent }; return x }
                assertTrue("limit card inside header", right(limit) <= header.width)
                assertTrue("pill does not overlap the speed", pill.measuredWidth > 0 && speed.measuredWidth > 0)
                assertTrue(header.measuredWidth <= 720)
            }
        }
    }
}
