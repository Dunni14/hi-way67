// Decides what a group/DM message is for. LLM first, keyword fallback if the
// LLM is unavailable so the demo never stalls.
import { chatJson, chat } from "../llm/openrouter.ts";
import { config } from "../config.ts";

export type Kind = "question" | "to_driver" | "roast_reply" | "arrival_pref" | "chatter";
export type Classified = { kind: Kind; text: string };

export async function classify(opts: {
  text: string;
  senderName: string;
  isGroup: boolean;
  roastActive: boolean;
}): Promise<Classified> {
  const driver = config.driverName;
  const system = `You route messages in a family group chat that includes an AI driving assistant for ${driver}, who is currently driving.
Classify the message into exactly one kind:
- "question": asks the assistant about ${driver} or the trip (where is ${driver}, how long driving, has ${driver} stopped, are they okay).
- "to_driver": something meant to be passed on to ${driver} ("tell ${driver} ...", "${driver} grab coffee", a direct message to ${driver}). "text" = the message to read to ${driver}, phrased as the sender would say it, without "tell ${driver}".
- "roast_reply": ${opts.roastActive ? `a roast, joke or teasing aimed at ${driver} to wake them up (a roast is in progress, so most playful messages are this). "text" = the roast.` : `never use this kind right now.`}
- "arrival_pref": the sender asks to be told when ${driver} arrives.
- "chatter": people talking among themselves, not to the assistant or ${driver}. ${opts.isGroup ? "" : "(This is a direct message to the assistant, so chatter is unlikely.)"}
Return {"kind": "...", "text": "..."}; "text" may be empty for "question", "arrival_pref" and "chatter".`;

  try {
    const out = await chatJson<Classified>({
      model: config.openRouter.models.classify,
      system,
      user: `${opts.senderName}: ${opts.text}`,
      maxTokens: 150,
    });
    if (!["question", "to_driver", "roast_reply", "arrival_pref", "chatter"].includes(out.kind)) throw new Error(`bad kind ${out.kind}`);
    if (out.kind === "roast_reply" && !opts.roastActive) out.kind = "to_driver";
    return { kind: out.kind, text: out.text || opts.text };
  } catch (err) {
    console.warn("[classify] LLM failed, using keyword fallback:", (err as Error).message);
    return fallback(opts.text, opts.roastActive, opts.isGroup);
  }
}

function fallback(text: string, roastActive: boolean, isGroup: boolean): Classified {
  const t = text.toLowerCase();
  const name = config.driverName.toLowerCase();
  if (/(let me know|tell me|text me|message me).*(arriv|get there|gets there|home)/.test(t)) return { kind: "arrival_pref", text };
  if (t.startsWith(`tell ${name}`)) return { kind: "to_driver", text: text.slice(`tell ${name}`.length).replace(/^[\s,:]*(to\s+)?/i, "") };
  if (/\?$/.test(t) || /^(where|how|has|is|did|when|what)\b/.test(t)) return { kind: "question", text };
  if (roastActive) return { kind: "roast_reply", text };
  if (t.includes(name) || !isGroup) return { kind: "to_driver", text };
  return { kind: "chatter", text };
}

/** Make something sayable in one short spoken line. */
export async function shortenForSpeech(text: string): Promise<string> {
  const oneLine = text.replace(/\s+/g, " ").replace(/https?:\/\/\S+/g, "a link").trim();
  if (oneLine.length <= 120) return oneLine;
  try {
    return await chat({
      model: config.openRouter.models.shorten,
      system: "Shorten this chat message into one short spoken sentence (max 20 words). Keep the sender's voice and the joke if there is one. Output only the sentence.",
      user: oneLine,
      maxTokens: 60,
    });
  } catch {
    return `${oneLine.slice(0, 117)}...`;
  }
}
