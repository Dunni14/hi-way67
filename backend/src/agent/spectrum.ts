// Photon Spectrum connection: inbound message loop + outbound posting.
// The family group chat `space` is captured the first time an allowlisted
// contact writes in a group (or anyone sends "/start" there) and reused for
// proactive posts. If no group is known, posts fan out to known DM spaces.
import { Spectrum, attachment, type Message, type Space } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { telegram } from "@spectrum-ts/telegram";
import { config, required } from "../config.ts";
import { allContacts, contactPlatform, lookupContact, type Contact, type Platform, type Role } from "./contacts.ts";

export type Inbound = { contact: Contact; space: Space; message: Message; text: string; isGroup: boolean };

let app: Awaited<ReturnType<typeof Spectrum>> | null = null;
let groupSpace: Space | null = null;
const dmSpaces = new Map<string, Space>(); // handle -> DM space

const spaceType = (space: Space) => (space as { type?: string }).type;

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
  const perPlatform = allContacts().reduce<Record<string, number>>((n, c) => ({ ...n, [contactPlatform(c)]: (n[contactPlatform(c)] ?? 0) + 1 }), {});
  console.log(`[spectrum] connected: ${enabled.join(", ")}; contacts: ${JSON.stringify(perPlatform)}. Send /start in the family group to bind it.`);

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
    console.log(`[spectrum] group chat bound via /start: ${platform} ${space.id}`);
    await space.send(`Hi! I'm ${config.driverName}'s driving buddy. Ask me where ${config.driverName} is, or send a message for me to read to them.`);
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
    console.log(`[spectrum] group chat captured: ${space.id}`);
  }
  if (!isGroup) dmSpaces.set(contact.handle, space);

  const body = describeContent(message, contact.name);
  if (!body) return;
  await onMessage({ contact, space, message, text: body, isGroup });
}

/** Anything `space.send` takes besides the text itself, such as an attachment. */
export type Extra = Parameters<Space["send"]>[number];

/** `space.send` takes either one item or at least two, so pick the overload by how many extras there are. */
function sendAll(space: Space, text: string, extra: Extra[]) {
  const [first, ...rest] = extra;
  return first === undefined ? space.send(text) : space.send(text, first, ...rest);
}

/** A PNG as outbound content, to pass as an extra to `post` or `dm`. */
export const pngAttachment = (png: Buffer, name: string): Extra => attachment(png, { name, mimeType: "image/png" });

/** Post to the family group (or every known DM as fallback). `minRole` limits who receives it. Extras follow the text. */
export async function post(text: string, minRole: Role = "friend", ...extra: Extra[]) {
  if (groupSpace && minRole === "friend") {
    await sendAll(groupSpace, text, extra);
    return;
  }
  const targets = allContacts().filter((c) => minRole === "friend" || c.role === "guardian");
  if (targets.length === 0) {
    // Dev mode (no contacts.json): best we can do is the group.
    if (groupSpace) await sendAll(groupSpace, text, extra);
    else console.warn(`[spectrum] no group chat or contacts yet, not posted: ${text}`);
    return;
  }
  for (const c of targets) await dm(c.handle, text, ...extra);
}

/**
 * Direct message one contact. Reuses the DM space we saw them write from; only
 * iMessage DMs can be opened from our side (Telegram bots can't start a chat).
 */
export async function dm(handle: string, text: string, ...extra: Extra[]) {
  try {
    let space = dmSpaces.get(handle);
    const contact = allContacts().find((c) => c.handle === handle);
    if (!space && app && (!contact || contactPlatform(contact) === "imessage")) {
      space = await imessage(app).space.create(handle);
      dmSpaces.set(handle, space);
    }
    if (!space) {
      console.warn(`[spectrum] can't DM ${contact?.name ?? handle} on telegram until they message the bot privately once`);
      return;
    }
    await sendAll(space, text, extra);
  } catch (err) {
    console.error(`[spectrum] DM to ${handle} failed:`, err);
  }
}

export function hasGroup() {
  return groupSpace !== null;
}
