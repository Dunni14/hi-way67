// Allowlist of people the agent talks to. contacts.json (gitignored):
//   [{ "handle": "+15551234567", "name": "Mom", "role": "guardian" },
//    { "handle": "123456789", "name": "Sam", "role": "friend", "platform": "telegram" }, ...]
// handle = what Spectrum reports as sender.id: phone in E.164 or iMessage email,
// or the numeric user id on Telegram (the backend logs it for unknown senders).
// The list is live: the phone app adds and removes contacts (Telegram ones through
// an invite link, see invites.ts), and every change is written back to the file.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";

export type Role = "guardian" | "friend";
export type Platform = "imessage" | "telegram";
export type Contact = { handle: string; name: string; role: Role; platform?: Platform };

export function normalizeHandle(handle: string) {
  const h = handle.trim().toLowerCase();
  if (h.includes("@")) return h;
  const digits = h.replace(/[^\d]/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** Telegram ids are numeric user ids, not phone numbers: keep them raw. */
function handleFor(handle: string, platform: Platform | undefined) {
  return platform === "telegram" ? handle.trim() : normalizeHandle(handle);
}

export function contactPlatform(c: Contact): Platform {
  return c.platform ?? "imessage";
}

function load(): Contact[] | null {
  if (!existsSync(config.contactsPath)) {
    console.warn(`[contacts] ${config.contactsPath} not found: dev mode, every sender is treated as a guardian until a contact is added`);
    return null;
  }
  const list = JSON.parse(readFileSync(config.contactsPath, "utf8")) as Contact[];
  return list.map((c) => ({ ...c, handle: handleFor(c.handle, c.platform) }));
}

// null = dev mode (no file yet). The first addContact creates the file and ends dev mode.
let contacts = load();

function save() {
  const tmp = `${config.contactsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(contacts ?? [], null, 2) + "\n");
  renameSync(tmp, config.contactsPath);
}

export function lookupContact(senderId: string | undefined, platform?: Platform): Contact | null {
  if (!senderId) return null;
  const handle = handleFor(senderId, platform);
  if (contacts === null) return { handle, name: senderId, role: "guardian", platform };
  const samePlatform = (c: Contact) => (platform === "telegram") === (contactPlatform(c) === "telegram");
  return contacts.find((c) => c.handle === handle && samePlatform(c)) ?? null;
}

export function allContacts(): Contact[] {
  return contacts ?? [];
}

/** Add or update (same handle and platform) a contact, and persist. Returns the stored contact. */
export function addContact(c: Contact): Contact {
  const stored: Contact = { ...c, handle: handleFor(c.handle, c.platform) };
  const list = (contacts ?? []).filter((x) => !(x.handle === stored.handle && contactPlatform(x) === contactPlatform(stored)));
  contacts = [...list, stored];
  save();
  console.log(`[contacts] added ${stored.name} (${stored.role}, ${contactPlatform(stored)})`);
  return stored;
}

/** Change a contact's role, and persist. Returns false if no contact has this handle. */
export function setContactRole(handle: string, role: Role): boolean {
  if (!contacts) return false;
  const keys = new Set([handle.trim(), normalizeHandle(handle)]);
  let found = false;
  contacts = contacts.map((c) => (keys.has(c.handle) ? ((found = true), { ...c, role }) : c));
  if (found) save();
  return found;
}

/** Remove every contact with this handle (raw or normalized). Returns false if none matched. */
export function removeContact(handle: string): boolean {
  if (!contacts) return false;
  const keys = new Set([handle.trim(), normalizeHandle(handle)]);
  const kept = contacts.filter((c) => !keys.has(c.handle));
  if (kept.length === contacts.length) return false;
  contacts = kept;
  save();
  console.log(`[contacts] removed ${handle}`);
  return true;
}
