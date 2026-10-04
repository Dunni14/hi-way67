package dev.driverguardian.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Palette and shapes from the Figma file (MHacks | AutoAI, "UI" section). Mockups: docs/design/figma/.
internal val Main = Color(0xFF366DE1) // Menu main
internal val Good = Color(0xFF30A54D)
internal val Bad = Color(0xFFF35C5C)
internal val Warn = Color(0xFFFFB74D)
internal val SystemText = Color(0xFF495675) // System color
internal val OnSurface = Color(0xFF1D1B20)
internal val Ink = Color(0xFF16213E) // Stats headings: dark navy, not black
internal val Muted = Color(0xFF7A869E) // Stats subtitles
internal val Surface = Color(0xFFF9FCFE) // Background color
internal val TabBg = Color(0xFFFDFDFD) // Tab background
internal val Pressed = Color(0xFFECF4FD) // Button pressed
internal val Hairline = Color(0xFFE6EEF9) // Card edge on the pale background
internal val GoodTint = Color(0xFFE5F5EA)
internal val BadTint = Color(0xFFFDE8E8)
internal val ScreenBg = Brush.verticalGradient(listOf(Color(0xFFF3F8FE), Color(0xFFECF4FE)))
internal val CardShape = RoundedCornerShape(20.dp)
internal val Label = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, lineHeight = 15.sp, letterSpacing = 0.5.sp)
internal val ScreenTitle = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.Bold, lineHeight = 34.sp, color = Ink)
internal val SectionTitleStyle = TextStyle(fontSize = 19.sp, fontWeight = FontWeight.Bold, lineHeight = 24.sp, color = Ink)

val DriverGuardianColors = lightColorScheme(primary = Main, surface = Surface, onSurface = OnSurface)

/** The mockups' white card: soft blue-tinted shadow, hairline edge. */
internal fun Modifier.card(shape: Shape = CardShape, color: Color = Color.White, elevation: Dp = 6.dp): Modifier =
    shadow(elevation, shape, ambientColor = Main.copy(alpha = 0.12f), spotColor = Main.copy(alpha = 0.12f))
        .clip(shape).background(color).border(1.dp, if (color == Color.White) Hairline else color, shape)

/** Icon on a pale round badge, as in the Stats mockup's tiles. */
@Composable
internal fun IconBadge(icon: ImageVector, tint: Color = Main, bg: Color = Pressed, size: Dp = 44.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.55f))
    }
}

@Composable
internal fun IconBadge(icon: Painter, tint: Color = Main, bg: Color = Pressed, size: Dp = 44.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** Loading state for a screen or list: the blue spinner on a white card, with what is loading. */
@Composable
internal fun Throbber(label: String, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().card().padding(vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator(color = Main, trackColor = Pressed, strokeWidth = 4.dp, strokeCap = StrokeCap.Round, modifier = Modifier.size(36.dp))
        Text(label, color = Muted, fontSize = 14.sp)
    }
}

/** Inline spinner for buttons and pills. */
@Composable
internal fun SmallThrobber(color: Color = Main, size: Dp = 16.dp) {
    CircularProgressIndicator(color = color, strokeWidth = 2.dp, strokeCap = StrokeCap.Round, modifier = Modifier.size(size))
}

/** Text button that swaps its label for a spinner while [busy], e.g. Refresh during a reload. */
@Composable
internal fun BusyTextButton(text: String, busy: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    TextButton(onClick = onClick, enabled = !busy, modifier = modifier) {
        Box(contentAlignment = Alignment.Center) {
            // The invisible label keeps the button the same width while the spinner shows.
            Text(text, color = if (busy) Color.Transparent else Main, fontWeight = FontWeight.SemiBold)
            if (busy) SmallThrobber()
        }
    }
}
