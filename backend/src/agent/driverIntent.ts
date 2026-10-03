// What did the driver mean? Regex only: it's instant and the phrases are few.
// `context` is what the phone was listening after (see protocol.ts).

export type DriverIntent =
  | { kind: "dismiss" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "reply"; text: string }
  | { kind: "unknown" };

const DISMISS = /\b(i'?m|i am)\s+(fine|good|ok(ay)?|awake|alright|all right)\b|\bleave me alone\b|\bstop it\b/i;
const YES = /^(yes|yeah|yep|yup|sure|please|ok(ay)?|do it|go ahead)\b/i;
const NO = /^(no|nope|nah|don'?t|do not)\b/i;
const TELL = /^(tell|text|message|let)\s+(her|him|them|everyone|the group|mom|dad|[a-z]+)\s+(know\s+)?(that\s+)?(?<msg>.+)$/i;

export function parseDriverUtterance(raw: string, context: string): DriverIntent {
  const text = raw.trim();
  if (!text) return { kind: "unknown" };
  if (DISMISS.test(text)) return { kind: "dismiss" };

  const tell = text.match(TELL);
  if (tell?.groups?.msg) return { kind: "reply", text: tell.groups.msg };

  if (YES.test(text)) return { kind: "yes" };
  if (NO.test(text)) return { kind: "no" };

  // After a family message or a roast, anything else is a reply to the group.
  if (context === "after_message" || context === "roast") return { kind: "reply", text };
  return { kind: "unknown" };
}
