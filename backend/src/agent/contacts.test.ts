import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// contacts.ts reads CONTACTS_PATH at import: point it at an empty temp dir first (dev mode, no file).
const path = join(mkdtempSync(join(tmpdir(), "dg-contacts-")), "contacts.json");
process.env.CONTACTS_PATH = path;
const { addContact, allContacts, lookupContact, removeContact, setContactRole } = await import("./contacts.ts");
const { createInvite, redeemInvite } = await import("./invites.ts");

test("dev mode until the first contact, then the file is the allowlist", () => {
  assert.equal(lookupContact("+15550000000", "imessage")?.role, "guardian");
  addContact({ handle: "(555) 123-4567", name: "Mom", role: "guardian", platform: "imessage" });
  assert.ok(existsSync(path));
  assert.equal(lookupContact("+15550000000", "imessage"), null);
  assert.equal(lookupContact("5551234567", "imessage")?.name, "Mom");
});

test("telegram ids stay raw and only match telegram senders", () => {
  addContact({ handle: "1234567890", name: "Sam", role: "friend", platform: "telegram" });
  assert.equal(lookupContact("1234567890", "telegram")?.handle, "1234567890");
  assert.equal(lookupContact("1234567890", "imessage"), null); // not +11234567890
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(saved.map((c: { handle: string }) => c.handle), ["+15551234567", "1234567890"]);
});

test("re-adding updates, remove persists", () => {
  addContact({ handle: "1234567890", name: "Sammy", role: "guardian", platform: "telegram" });
  assert.equal(allContacts().length, 2);
  assert.equal(lookupContact("1234567890", "telegram")?.name, "Sammy");
  assert.equal(setContactRole("1234567890", "friend"), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8"))[1].role, "friend");
  assert.equal(setContactRole("999", "friend"), false);
  assert.equal(removeContact("1234567890"), true);
  assert.equal(removeContact("1234567890"), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).length, 1);
});

test("invites are 6 chars, single use, expire after 15 min", () => {
  const now = 1_000_000;
  const code = createInvite("Jo", "friend", now);
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(redeemInvite(code.toLowerCase(), now + 1000), { name: "Jo", role: "friend", expiresAt: now + 15 * 60_000 });
  assert.equal(redeemInvite(code, now + 1000), null);
  const late = createInvite("Jo", "friend", now);
  assert.equal(redeemInvite(late, now + 15 * 60_000), null);
});
