// Photon Spectrum connection: inbound message loop + outbound posting.
// The family group chat `space` is captured the first time an allowlisted
// contact writes in a group (or anyone sends "/start" there) and reused for
// proactive posts. If no group is known, posts fan out to known DM spaces.
// The binding is saved to .group.json and restored at startup (GROUP_CHAT_ID overrides it).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Spectrum, attachment, type Message, type Space } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { telegram } from "@spectrum-ts/telegram";
import { config, required } from "../config.ts";
import { addContact, allContacts, contactPlatform, lookupContact, type Contact, type Platform, type Role } from "./contacts.ts";
import { redeemInvite } from "./invites.ts";
import { trip } from "../trip/state.ts";
import { sendToPhone } from "../ws/server.ts";

/** `reactionTo`: set for an emoji reaction (`text` is the emoji); the id of the message it reacts to. */
export type Inbound = { contact: Contact; space: Space; message: Message; text: string; isGroup: boolean; reactionTo?: string };

let app: Awaited<ReturnType<typeof Spectrum>> | null = null;
let groupSpace: Space | null = null;
const dmSpaces = new Map<string, Space>(); // handle -> DM space

const spaceType = (space: Space) => (space as { type?: string }).type;

const GROUP_FILE = ".group.json";

/** Remember the group binding so a restart doesn't need another /start. */
function saveGroup(space: Space) {
  try {
    writeFileSync(GROUP_FILE, JSON.stringify({ platform: space.__platform, id: space.id }) + "\n");
  } catch (err) {
    console.error(`[spectrum] could not save ${GROUP_FILE}:`, err);
  }
}

/** Rebind the group from GROUP_CHAT_ID (+ GROUP_CHAT_PLATFORM), else .group.json. Failure leaves auto-capture to do it. */
async function restoreGroup() {
  let saved: { platform: string; id: string } | null = null;
  if (config.groupChat.id) saved = { platform: config.groupChat.platform, id: config.groupChat.id };
  else if (existsSync(GROUP_FILE)) {
    try {
      saved = JSON.parse(readFileSync(GROUP_FILE, "utf8"));
    } catch (err) {
      console.error(`[spectrum] ignoring unreadable ${GROUP_FILE}:`, err);
    }
  }
  if (!saved?.id) return;
  if (!config.spectrum.providers.includes(saved.platform)) {
    console.warn(`[spectrum] saved group is on ${saved.platform}, which is not in SPECTRUM_PROVIDERS; not restored`);
    return;
  }
  try {
    // `app` is built from a runtime provider list, so its type doesn't carry either provider.
    const provider = (saved.platform === "telegram" ? telegram : imessage) as unknown as (a: unknown) => { space: { get(id: string): Promise<Space> } };
    groupSpace = await provider(app).space.get(saved.id);
    console.log(`[spectrum] group chat restored: ${saved.platform} ${saved.id}`);
  } catch (err) {
    console.error(`[spectrum] could not restore group ${saved.platform} ${saved.id}; send /start in the group again:`, err);
  }
}

/** Text for anything the agent might relay; non-text content becomes a short description. */
export function describeContent(message: Message, senderName: string): string | null {
  const c = message.content;
  switch (c.type) {
    case "text":
      return c.text;
    case "attachment":
      return c.mimeType.startsWith("image/") ? `${senderName} sent a photo.`
        : c.mimeType.startsWith("video/") ? `${senderName} sent a video.`
        : `${senderName} sent a file.`;
    case "richlink":
      return `${senderName} sent a link.`;
    default:
      return null; // reactions, typing, edits, etc. are ignored
  }
}

export async function startSpectrum(onMessage: (m: Inbound) => Promise<void>) {
  const enabled = config.spectrum.providers;
  const providers = [];
  if (enabled.includes("imessage")) providers.push(imessage.config());
  if (enabled.includes("telegram")) providers.push(telegram.config({ botToken: required("TELEGRAM_BOT_TOKEN") }));

  app = await Spectrum({
    projectId: config.spectrum.projectId(),
    projectSecret: config.spectrum.projectSecret(),
    providers,
  });
  await restoreGroup();
  const perPlatform = allContacts().reduce<Record<string, number>>((n, c) => ({ ...n, [contactPlatform(c)]: (n[contactPlatform(c)] ?? 0) + 1 }), {});
  console.log(`[spectrum] connected: ${enabled.join(", ")}; contacts: ${JSON.stringify(perPlatform)}.${groupSpace ? "" : " Send /start in the family group to bind it."}`);

  void (async () => {
    for await (const [space, message] of app!.messages) {
      if (message.direction !== "inbound") continue;
      try {
        await route(space, message, onMessage);
      } catch (err) {
        console.error("[spectrum] handler error:", err);
      }
    }
  })();
}

async function route(space: Space, message: Message, onMessage: (m: Inbound) => Promise<void>) {
  const platform = space.__platform as Platform;
  const contact = lookupContact(message.sender?.id, platform);
  // Telegram has no "group" type field; treat anything that isn't an iMessage DM as a possible group.
  const isGroup = spaceType(space) === "group" || (space.__platform !== "imessage" && space.id.startsWith("-"));
  const text = message.content.type === "text" ? message.content.text.trim() : "";

  // Telegram sends "/start@BotName" when the command is picked from the menu in a group.
  if (/^\/start(@\w+)?$/i.test(text) && isGroup) {
    groupSpace = space;
    saveGroup(space);
    console.log(`[spectrum] group chat bound via /start: ${platform} ${space.id}`);
    await space.send(
      "Hi everyone! I'm Driver Guardian, this group's driving buddy. While someone's on the road, ask me where they are or how they're doing, or send them a message and I'll read it out loud.",
    );
    return;
  }
  // Invite link from the phone app (t.me/<bot>?start=<code>) opened in a private chat.
  const invite = !isGroup && message.sender?.id ? /^\/start\s+(\w+)$/i.exec(text) : null;
  if (invite) {
    const inv = redeemInvite(invite[1]!);
    if (!inv) {
      await space.send("That invite code is invalid or has expired. Ask the driver for a new link.");
      return;
    }
    const added = addContact({ handle: message.sender!.id, name: inv.name, role: inv.role, platform });
    dmSpaces.set(added.handle, space);
    await space.send(`You're on ${trip.driverName}'s road crew 🚗`);
    sendToPhone({ type: "contact_joined", name: added.name, role: added.role });
    return;
  }
  if (!contact) {
    const id = message.sender?.id;
    console.log(
      `[spectrum] ignoring non-allowlisted ${platform} sender ${id}. To allow them, add to contacts.json: ` +
        JSON.stringify({ handle: id, name: "<name>", role: "friend", platform }),
    );
    return;
  }

  if (isGroup && !groupSpace) {
    groupSpace = space;
    saveGroup(space);
    console.log(`[spectrum] group chat captured: ${space.id}`);
  }
  if (!isGroup) dmSpaces.set(contact.handle, space);

  // Reactions only matter as sound poll votes (Telegram delivers them only if the bot gets message_reaction updates).
  if (message.content.type === "reaction") {
    await onMessage({ contact, space, message, text: message.content.emoji, isGroup, reactionTo: message.content.target.id });
    return;
  }
  const body = describeContent(message, contact.name);
  if (!body) return;
  await onMessage({ contact, space, message, text: body, isGroup });
}

type Content = Parameters<Space["send"]>[0];
/** Builds the content per recipient: an attachment builder should not be shared between sends. */
type MakeContent = () => Content;

/**
 * Post to the family group (or every known DM as fallback). `minRole` limits who receives it.
 * Returns the ids of the messages sent (empty if the platform returned none), e.g. to match reactions.
 */
export async function post(text: string, minRole: Role = "friend"): Promise<string[]> {
  return deliver(() => text, minRole, text);
}

/** Same routing as `post`, with a PNG attachment. */
export async function postImage(png: Buffer, minRole: Role = "friend", name = "drive-report.png") {
  await deliver(() => attachment(png, { name, mimeType: "image/png" }), minRole, `[image ${name}]`);
}

async function deliver(make: MakeContent, minRole: Role, label: string): Promise<string[]> {
  const ids = (m: { id?: string } | undefined) => (m?.id ? [m.id] : []);
  if (groupSpace && minRole === "friend") return ids(await groupSpace.send(make()));
  const targets = allContacts().filter((c) => minRole === "friend" || c.role === "guardian");
  if (targets.length === 0) {
    // Dev mode (no contacts.json): best we can do is the group.
    if (groupSpace) return ids(await groupSpace.send(make()));
    console.warn(`[spectrum] no group chat or contacts yet, not posted: ${label}`);
    return [];
  }
  const sent: string[] = [];
  for (const c of targets) sent.push(...ids(await dmContent(c.handle, make)));
  return sent;
}

/**
 * Direct message one contact. Reuses the DM space we saw them write from; only
 * iMessage DMs can be opened from our side (Telegram bots can't start a chat).
 */
export async function dm(handle: string, text: string) {
  await dmContent(handle, () => text);
}

export async function dmImage(handle: string, png: Buffer, name = "drive-report.png") {
  await dmContent(handle, () => attachment(png, { name, mimeType: "image/png" }));
}

async function dmContent(handle: string, make: MakeContent) {
  try {
    let space = dmSpaces.get(handle);
    const contact = allContacts().find((c) => c.handle === handle);
    if (!space && app && (!contact || contactPlatform(contact) === "imessage")) {
      space = await imessage(app).space.create(handle);
      dmSpaces.set(handle, space);
    }
    if (!space) {
      console.warn(`[spectrum] can't DM ${contact?.name ?? handle} on telegram until they message the bot privately once`);
      return undefined;
    }
    return await space.send(make());
  } catch (err) {
    console.error(`[spectrum] DM to ${handle} failed:`, err);
    return undefined;
  }
}

export function hasGroup() {
  return groupSpace !== null;
}
