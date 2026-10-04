// One-time invite codes for Telegram contacts. A Telegram bot can't message someone
// by phone number or @username; it only learns their numeric id once they write to it.
// So the phone asks for an invite, the driver shares the t.me link, and opening it
// sends "/start <code>" to the bot, which redeems the code (spectrum.ts) and adds the sender.
// In memory: a restart drops pending invites.
import { randomInt } from "node:crypto";
import type { Role } from "./contacts.ts";

export type Invite = { name: string; role: Role; expiresAt: number };

const TTL_MS = 15 * 60_000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const invites = new Map<string, Invite>();

function prune(now: number) {
  for (const [code, inv] of invites) if (inv.expiresAt <= now) invites.delete(code);
}

export function createInvite(name: string, role: Role, now = Date.now()): string {
  prune(now);
  let code: string;
  do code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  while (invites.has(code));
  invites.set(code, { name, role, expiresAt: now + TTL_MS });
  return code;
}

/** Single use: returns the invite and deletes it, or null if unknown or expired. */
export function redeemInvite(code: string, now = Date.now()): Invite | null {
  const key = code.toUpperCase();
  const inv = invites.get(key);
  invites.delete(key);
  return inv && inv.expiresAt > now ? inv : null;
}
