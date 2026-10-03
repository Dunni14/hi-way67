// Allowlist of people the agent talks to. contacts.json (gitignored):
//   [{ "handle": "+15551234567", "name": "Mom", "role": "guardian" }, ...]
// handle = phone in E.164 or iMessage email, i.e. what Spectrum reports as sender.id.
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.ts";

export type Role = "guardian" | "friend";
export type Contact = { handle: string; name: string; role: Role };

export function normalizeHandle(handle: string) {
  const h = handle.trim().toLowerCase();
  if (h.includes("@")) return h;
  const digits = h.replace(/[^\d]/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function load(): Contact[] | null {
  if (!existsSync(config.contactsPath)) {
    console.warn(`[contacts] ${config.contactsPath} not found: dev mode, every sender is treated as a guardian`);
    return null;
  }
  const list = JSON.parse(readFileSync(config.contactsPath, "utf8")) as Contact[];
  return list.map((c) => ({ ...c, handle: normalizeHandle(c.handle) }));
}

const contacts = load();

export function lookupContact(senderId: string | undefined): Contact | null {
  if (!senderId) return null;
  const handle = normalizeHandle(senderId);
  if (contacts === null) return { handle, name: senderId, role: "guardian" };
  return contacts.find((c) => c.handle === handle) ?? null;
}

export function allContacts(): Contact[] {
  return contacts ?? [];
}
