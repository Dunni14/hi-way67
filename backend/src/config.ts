// Central env access. Keys for optional services are read lazily so the app
// still boots (and smoke tests still run) when one of them is missing.

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  port: Number(optional("PORT", "8787")),
  driverName: optional("DRIVER_NAME", "Alex"),
  contactsPath: optional("CONTACTS_PATH", "contacts.json"),
  spectrum: {
    projectId: () => process.env.SPECTRUM_PROJECT_ID?.trim() || required("PROJECT_ID"),
    projectSecret: () => process.env.SPECTRUM_PROJECT_SECRET?.trim() || required("PROJECT_SECRET"),
    // Comma list of providers to enable: imessage, telegram.
    providers: optional("SPECTRUM_PROVIDERS", "imessage").split(",").map((p) => p.trim()).filter(Boolean),
  },
  telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),

  elevenLabs: {
    apiKey: () => required("ELEVENLABS_API_KEY"),
    voiceId: optional("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
    modelId: optional("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
  },

  openRouter: {
    apiKey: () => required("OPENROUTER_API_KEY"),
    models: {
      classify: optional("MODEL_CLASSIFY", "anthropic/claude-haiku-4.5"),
      answer: optional("MODEL_ANSWER", "anthropic/claude-haiku-4.5"),
      shorten: optional("MODEL_SHORTEN", "anthropic/claude-haiku-4.5"),
    },
  },

  // Postgres (Tiger Data / Timescale compatible). Unset = risk REST API disabled.
  databaseUrl: optional("DATABASE_URL"),
  // Tiger Data for the adaptive-recommendation bandit. Unset = bandit off (needs DATABASE_URL too).
  tigerDatabaseUrl: optional("TIGER_DATABASE_URL"),

  roastWindowMs: 3 * 60_000,
};
