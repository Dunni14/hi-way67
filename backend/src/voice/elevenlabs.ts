// ElevenLabs text-to-speech. Same voice for every tier; delivery changes via
// voice_settings (lower stability + higher style = more urgent / expressive).
import { config } from "../config.ts";
import type { Tier } from "../ws/protocol.ts";

const SETTINGS: Record<Tier | 0, { stability: number; similarity_boost: number; style: number }> = {
  0: { stability: 0.55, similarity_boost: 0.75, style: 0.25 }, // neutral: reading messages
  40: { stability: 0.65, similarity_boost: 0.75, style: 0.2 }, // calm, warm
  70: { stability: 0.45, similarity_boost: 0.8, style: 0.5 }, // firm
  85: { stability: 0.25, similarity_boost: 0.85, style: 0.85 }, // urgent
};

export async function tts(text: string, tier: Tier | 0 = 0): Promise<Buffer> {
  const { voiceId, modelId } = config.elevenLabs;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": config.elevenLabs.apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { ...SETTINGS[tier], use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
