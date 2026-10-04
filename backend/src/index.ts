// Boot: trip store -> orchestrator -> phone WebSocket + Spectrum agent.
// Set NO_SPECTRUM=1 to run only the phone side (voice testing without iMessage).
import { config } from "./config.ts";
import { InMemoryTripStore } from "./trip/store.ts";
import { trip } from "./trip/state.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { startPhoneServer } from "./ws/server.ts";
import { startSpectrum, hasGroup } from "./agent/spectrum.ts";
import { roast } from "./agent/roast.ts";
import { soundPoll } from "./agent/soundPoll.ts";
import { createDevChatRoute } from "./dev/devChat.ts";
import { driverQueue } from "./voice/driverQueue.ts";
import pg from "pg";
import { PgRiskStore, type Db } from "./risk/store/pg.ts";
import { RiskService } from "./risk/service.ts";
import { createRiskRoutes } from "./http/risk.ts";
import { demoRoutes } from "./http/demo.ts";
import { PgBanditStore } from "./bandit/store.ts";
import { BanditService } from "./bandit/service.ts";
import { policyFacts } from "./agent/answer.ts";

// Live trip facts for the chat agent (recent trips, contact preferences). Scored trips live in the risk store.
const store = new InMemoryTripStore();
const { onPhone, onChat, onRiskEvaluation, setInsights, setRisk } = createOrchestrator(store);

// One pool per Postgres / Tiger Data service, shared by the risk engine and (when it points at the same
// database) the bandit. Sized for a small Tiger instance; a dropped idle connection must not crash the process.
const newPool = (connectionString: string) => {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
  pool.on("error", (err) => console.warn("[db] idle connection error:", err.message));
  return pool;
};

// Risk engine: scores every phone window and decides every alert, so it always runs. It needs
// Postgres: DATABASE_URL (Tiger Data), or the local seeded in-process one when DATABASE_URL is
// unset or unreachable, or FAKE_DB=1.
let fakeBanditDb: Db | undefined;
let riskPool: pg.Pool | undefined;
async function openRiskStore(): Promise<PgRiskStore | undefined> {
  if (config.databaseUrl && !config.fakeDb) {
    const pool = newPool(config.databaseUrl);
    try {
      const real = new PgRiskStore(pool);
      await real.migrate();
      const timescale = await real.migrateTimescale();
      console.log(`[risk] REST API enabled (Postgres${timescale ? " + TimescaleDB" : ", no TimescaleDB: plain tables"})`);
      riskPool = pool;
      return real;
    } catch (err) {
      console.warn(`[risk] DATABASE_URL unreachable (${(err as Error).message}); falling back to the local fake database`);
      await pool.end().catch(() => {});
    }
  } else if (!config.fakeDb) {
    console.log("[risk] DATABASE_URL not set; using the local fake database (nothing is persisted)");
  }
  const { openFakeDb } = await import("./dev/fakeDb.ts");
  const fake = await openFakeDb({ dir: config.fakeDbDir });
  console.log(`[risk] REST API enabled (fake in-process Postgres, ${fake.seeded.trips} trips / ${fake.seeded.windows} windows seeded)`);
  fakeBanditDb = fake.db;
  return fake.store;
}

let riskRoutes: ReturnType<typeof createRiskRoutes> | undefined;
let bandit: BanditService | undefined;
const riskStore = await openRiskStore();
if (riskStore) {
  // Bandit: TIGER_DATABASE_URL if set, otherwise the fake database when that is what we are running on.
  let banditDb: Db | undefined = fakeBanditDb;
  if (config.tigerDatabaseUrl) {
    if (riskPool && config.tigerDatabaseUrl === config.databaseUrl) banditDb = riskPool;
    else {
      if (riskPool) console.warn("[bandit] TIGER_DATABASE_URL differs from DATABASE_URL: the bandit reads windows from one database and writes to another. Point both at the same service.");
      banditDb = newPool(config.tigerDatabaseUrl);
    }
  }
  if (banditDb) {
    const banditStore = new PgBanditStore(banditDb);
    await banditStore.migrate();
    bandit = new BanditService(banditStore, undefined, () => Boolean(config.elevenLabs.familyVoiceId));
  }
  const riskService = new RiskService(riskStore, undefined, (_tripId, ev, extra) => onRiskEvaluation(ev, extra), bandit);
  // The driver id the phone sends to the REST API is the driver's name.
  if (bandit) setInsights(async () => policyFacts(trip.driverName, await riskService.driverPolicy(trip.driverName)));
  setRisk(riskService);
  riskRoutes = createRiskRoutes(riskService);
  console.log(`[risk] adaptive recommendations ${bandit ? "on" : "off (TIGER_DATABASE_URL not set)"}`);
} else {
  console.error("[risk] no risk engine: phone windows will not be scored");
}

// Without Spectrum, POST /dev/chat stands in for the group chat (src/dev/devChat.ts).
const devChat = process.env.NO_SPECTRUM ? createDevChatRoute(onChat) : null;

startPhoneServer(config.port, onPhone, () => ({
  driverName: trip.driverName, // the driver id trips are stored under (GET /drivers/{id}/trips)
  tripActive: trip.active,
  sharingMode: trip.sharingMode,
  latestR: trip.latest?.R ?? null,
  roastActive: roast.active,
  queued: driverQueue.length,
  groupChatKnown: hasGroup(),
  pollActive: soundPoll.isActive,
  pollVotes: soundPoll.votes.size,
  // The demo speed slider (GET /demo) first, then /dev/chat (NO_SPECTRUM only), then the risk engine REST API.
}), async (req, res) =>
  (await demoRoutes(req, res)) || (devChat ? await devChat(req, res) : false) || (riskRoutes ? await riskRoutes(req, res) : false));

if (process.env.NO_SPECTRUM) {
  console.log("[spectrum] skipped (NO_SPECTRUM set)");
} else {
  await startSpectrum(onChat);
}
