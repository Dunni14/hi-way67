// Photon Spectrum connection: inbound message loop + outbound posting.
// The family group chat `space` is captured the first time an allowlisted
// contact writes in a group (or anyone sends "/start" there) and reused for
// proactive posts. If no group is known, posts fan out to known DM spaces.
import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { telegram } from "@spectrum-ts/telegram";
import { config, required } from "../config.ts";
import { allContacts, lookupContact, type Contact, type Role } from "./contacts.ts";

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
  console.log(`[spectrum] connected: ${enabled.join(", ")}`);

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
  const contact = lookupContact(message.sender?.id);
  // Telegram has no "group" type field; treat anything that isn't an iMessage DM as a possible group.
  const isGroup = spaceType(space) === "group" || (space.__platform !== "imessage" && space.id.startsWith("-"));
  const text = message.content.type === "text" ? message.content.text.trim() : "";

  if (text === "/start" && isGroup) {
    groupSpace = space;
    await space.send(`Hi! I'm ${config.driverName}'s driving buddy. Ask me where ${config.driverName} is, or send a message for me to read to them.`);
    return;
  }
  if (!contact) {
    console.log(`[spectrum] ignoring message from non-allowlisted sender ${message.sender?.id}`);
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

/** Post to the family group (or every known DM as fallback). `minRole` limits who receives it. */
export async function post(text: string, minRole: Role = "friend") {
  if (groupSpace && minRole === "friend") {
    await groupSpace.send(text);
    return;
  }
  const targets = allContacts().filter((c) => minRole === "friend" || c.role === "guardian");
  if (targets.length === 0) {
    // Dev mode (no contacts.json): best we can do is the group.
    if (groupSpace) await groupSpace.send(text);
    else console.warn(`[spectrum] no group chat or contacts yet, not posted: ${text}`);
    return;
  }
  for (const c of targets) await dm(c.handle, text);
}

/** Direct message one contact, creating the DM if we haven't seen one. */
export async function dm(handle: string, text: string) {
  try {
    let space = dmSpaces.get(handle);
    if (!space && app) {
      space = await imessage(app).space.create(handle);
      dmSpaces.set(handle, space);
    }
    await space?.send(text);
  } catch (err) {
    console.error(`[spectrum] DM to ${handle} failed:`, err);
  }
}

export function hasGroup() {
  return groupSpace !== null;
}
