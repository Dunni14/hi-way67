// Minimal OpenRouter client (OpenAI-compatible chat completions).
import { config } from "../config.ts";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chat(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouter.apiKey()}`,
      "Content-Type": "application/json",
      "X-Title": "Driver Guardian",
    },
    body: JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens ?? 300, temperature: 0.4 }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Ask for JSON and pull the first {...} block out of the reply. */
export async function chatJson<T>(opts: Parameters<typeof chat>[0]): Promise<T> {
  const raw = await chat({ ...opts, system: `${opts.system}\nRespond with a single JSON object and nothing else.` });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned no JSON: ${raw}`);
  return JSON.parse(match[0]) as T;
}
