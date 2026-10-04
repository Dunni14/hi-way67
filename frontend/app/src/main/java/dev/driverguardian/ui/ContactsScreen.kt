package dev.driverguardian.ui

import android.content.Intent
import android.net.Uri
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.driverguardian.net.Conn
import dev.driverguardian.trip.ContactsState
import dg.core.ContactInfo
import kotlinx.coroutines.delay

private val Pill = Color(0xFFDDE5FB) // search pill and + button in the Contacts mockup

/**
 * Contacts tab (Figma "Android Compact - 4"): the backend's allowlist. The switch makes a contact a
 * guardian (location and guardian-only alerts). + creates a Telegram invite link to share; "Create group"
 * opens Telegram's add-the-bot-to-a-group picker. Only reachable while parked, like every tab but Drive.
 */
@Composable
fun ContactsScreen(
    state: ContactsState,
    conn: Conn,
    onRefresh: () -> Unit,
    onAdd: (name: String, guardian: Boolean) -> Unit,
    onRemove: (handle: String) -> Unit,
    onGuardian: (handle: String, on: Boolean) -> Unit,
    onCloseInvite: () -> Unit,
    onJoinedSeen: () -> Unit,
) {
    val context = LocalContext.current
    var query by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<ContactInfo?>(null) }

    LaunchedEffect(conn) { if (conn == Conn.CONNECTED) onRefresh() }
    LaunchedEffect(state.joined) { if (state.joined != null) { delay(5_000); onJoinedSeen() } }

    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { query = it }
    }
    val shown = state.list.filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }

    Column(Modifier.fillMaxSize().background(ScreenBg).statusBarsPadding().padding(horizontal = 18.dp, vertical = 20.dp)) {
        Text("Contacts", style = ScreenTitle, color = SystemText, modifier = Modifier.padding(start = 4.dp, top = 12.dp, bottom = 14.dp))

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(24.dp)).background(Pill).padding(start = 16.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Search, contentDescription = null, tint = SystemText, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text("Search", color = SystemText, fontSize = 15.sp)
                    BasicTextField(query, { query = it }, singleLine = true, textStyle = TextStyle(fontFamily = Inter, color = Ink, fontSize = 15.sp), cursorBrush = SolidColor(Main), modifier = Modifier.fillMaxWidth())
                }
                IconButton(onClick = {
                    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_PROMPT, "Say a name")
                    runCatching { speech.launch(intent) }
                }) { Icon(Icons.Rounded.Mic, contentDescription = "Search by voice", tint = SystemText) }
            }
            Box(
                Modifier.size(48.dp).clip(CircleShape).background(Pill).clickable { adding = true },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Rounded.Add, contentDescription = "Add contact", tint = SystemText, modifier = Modifier.size(28.dp)) }
        }

        state.joined?.let {
            Row(
                Modifier.padding(top = 14.dp).fillMaxWidth().card(color = GoodTint, elevation = 0.dp).padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = Good)
                Spacer(Modifier.width(10.dp))
                Text(it, color = Ink, fontWeight = FontWeight.SemiBold)
            }
        }

        LazyColumn(
            Modifier.weight(1f).padding(top = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = 12.dp),
        ) {
            when {
                conn == Conn.CONNECTING && !state.loaded -> item { Throbber("Connecting to the backend") }
                conn != Conn.CONNECTED && !state.loaded -> item { Note("Not connected to the backend. Check the host under Settings.") }
                !state.loaded -> item { Throbber("Loading contacts") }
                state.list.isEmpty() -> item { Note("No contacts yet. Tap + to invite someone on Telegram.") }
                shown.isEmpty() -> item { Note("No contact matches \"$query\".") }
            }
            items(shown, key = { it.platform + it.handle }) { c ->
                ContactRow(c, onClick = { removing = c }, onGuardian = { onGuardian(c.handle, it) })
            }
        }

        if (state.groupBound) {
            Row(Modifier.padding(bottom = 8.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = Good, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Family group connected", color = SystemText, fontSize = 14.sp)
            }
        }
        Button(
            onClick = { state.groupLink?.let { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } },
            enabled = state.groupLink != null,
            modifier = Modifier.fillMaxWidth().height(54.dp),
            shape = RoundedCornerShape(27.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Main),
        ) { Text(if (state.groupBound) "Change group" else "Create group", fontSize = 18.sp, fontWeight = FontWeight.SemiBold) }
        Text(
            if (state.groupLink != null) "Pick a Telegram group for the bot, then send /start in it."
            else "Group setup needs TELEGRAM_BOT_USERNAME on the backend.",
            color = Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(top = 6.dp), textAlign = TextAlign.Center,
        )
    }

    if (adding) AddContactDialog(state, onCreate = onAdd, onDismiss = { adding = false; onCloseInvite() })

    removing?.let { c ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${c.name}?") },
            text = { Text("They will stop getting alerts and the bot will ignore their messages.") },
            confirmButton = { TextButton(onClick = { onRemove(c.handle); removing = null }) { Text("Remove", color = Bad) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
            containerColor = Color.White,
        )
    }
}

@Composable
private fun ContactRow(c: ContactInfo, onClick: () -> Unit, onGuardian: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().card().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(c.name)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(c.name, color = SystemText, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val role = if (c.role == "guardian") "Guardian" else "Friend"
            val where = if (c.platform == "telegram") "Telegram" else c.handle
            Text("$role · $where", color = SystemText, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Switch(
            checked = c.role == "guardian", onCheckedChange = onGuardian,
            colors = SwitchDefaults.colors(
                checkedTrackColor = Pill, checkedThumbColor = SystemText, checkedBorderColor = Pill,
                uncheckedTrackColor = Color.White, uncheckedBorderColor = Hairline, uncheckedThumbColor = Muted,
            ),
        )
    }
}

@Composable
private fun Avatar(name: String) {
    val initials = name.split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.first().uppercase() }
    Box(Modifier.size(52.dp).clip(CircleShape).background(Pressed), contentAlignment = Alignment.Center) {
        Text(initials.ifEmpty { "?" }, color = Main, fontSize = 19.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Note(text: String) {
    Text(text, color = SystemText, fontSize = 15.sp, lineHeight = 21.sp, modifier = Modifier.fillMaxWidth().card().padding(18.dp))
}

/** Name + guardian switch -> Telegram invite link to share. iMessage contacts are still added in contacts.json. */
@Composable
private fun AddContactDialog(state: ContactsState, onCreate: (String, Boolean) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var name by remember { mutableStateOf("") }
    var guardian by remember { mutableStateOf(false) }
    val invite = state.invite
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Color.White,
        title = { Text(if (invite == null) "Invite a contact" else "Invite for ${invite.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (invite == null) {
                    OutlinedTextField(
                        name, { name = it }, label = { Text("Name") }, singleLine = true, shape = RoundedCornerShape(14.dp),
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Main, unfocusedBorderColor = Hairline, focusedLabelColor = Main),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Guardian", color = Ink, fontWeight = FontWeight.SemiBold)
                            Text("Also gets your location and urgent alerts", color = Muted, fontSize = 13.sp)
                        }
                        Switch(guardian, { guardian = it }, colors = SwitchDefaults.colors(checkedTrackColor = Main))
                    }
                    Text("They join on Telegram by opening the link you share.", color = Muted, fontSize = 13.sp)
                } else {
                    Text("Send this link to ${invite.name}. Opening it in Telegram adds them. It works once and expires in 15 minutes.", color = SystemText)
                    Text(invite.link, color = Main, fontWeight = FontWeight.SemiBold, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Pressed).padding(12.dp))
                }
                state.error?.let { Text(it, color = Bad, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            if (invite == null) {
                TextButton(onClick = { onCreate(name, guardian) }, enabled = name.isNotBlank() && !state.inviting) {
                    if (state.inviting) {
                        SmallThrobber()
                        Spacer(Modifier.width(8.dp))
                        Text("Creating invite")
                    } else Text("Create invite")
                }
            } else {
                TextButton(onClick = {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, "Join my Driver Guardian road crew: ${invite.link}")
                    context.startActivity(Intent.createChooser(send, "Share invite"))
                }) { Text("Share link") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(if (invite == null) "Cancel" else "Done") } },
    )
}
