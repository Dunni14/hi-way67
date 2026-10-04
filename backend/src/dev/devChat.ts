// POST /dev/chat: inject a chat message as if an allowlisted contact wrote it, for testing chat flows
// (sound poll votes, questions, roasts) without Spectrum. Only mounted when NO_SPECTRUM is set.
//   curl -X POST localhost:8787/dev/chat -d '{"handle":"+15551234567","text":"1"}'
// Body: { handle, name?, text, isGroup? (default true), reaction? (true = `text` is an emoji reaction to the poll) }.
// Replies the agent would send are logged instead.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Message, Space } from "spectrum-ts";
import { lookupContact } from "../agent/contacts.ts";
import type { Inbound } from "../agent/spectrum.ts";
import { soundPoll } from "../agent/soundPoll.ts";

export function createDevChatRoute(onChat: (m: Inbound) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "POST" || req.url !== "/dev/chat") return false;
    let body: { handle?: string; name?: string; text?: string; isGroup?: boolean; reaction?: boolean };
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end("invalid JSON");
      return true;
    }
    if (!body.handle || !body.text) {
      res.writeHead(400).end("handle and text are required");
      return true;
    }
    const contact = lookupContact(body.handle, "imessage") ?? { handle: body.handle, name: body.name ?? body.handle, role: "guardian" as const };
    const log = (what: string) => async (t?: unknown) => console.log(`[dev/chat] agent ${what} to ${contact.name}:`, t ?? "");
    const message = { reply: log("replied"), react: log("reacted") } as unknown as Message;
    const space = { responding: async (fn: () => Promise<unknown>) => fn(), send: log("sent") } as unknown as Space;
    // A reaction targets the open poll's message; there is no real message id without Spectrum.
    const reactionTo = body.reaction ? "dev-poll-message" : undefined;
    if (reactionTo) soundPoll.addMessageId(reactionTo);
    await onChat({ contact, space, message, text: body.text, isGroup: body.isGroup ?? true, reactionTo });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, contact: contact.name }));
    return true;
  };
}
