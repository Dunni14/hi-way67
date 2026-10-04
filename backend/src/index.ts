// Boot: trip store -> orchestrator -> phone WebSocket + Spectrum agent.
// Set NO_SPECTRUM=1 to run only the phone side (voice testing without iMessage).
import { config } from "./config.ts";
import { InMemoryTripStore } from "./trip/store.ts";
import { trip } from "./trip/state.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { startPhoneServer } from "./ws/server.ts";
import { startSpectrum, hasGroup } from "./agent/spectrum.ts";
import { roast } from "./agent/roast.ts";
import { driverQueue } from "./voice/driverQueue.ts";
import pg from "pg";
import { PgRiskStore } from "./risk/store/pg.ts";
import { RiskService } from "./risk/service.ts";
import { createRiskRoutes } from "./http/risk.ts";
import { PgBanditStore } from "./bandit/store.ts";
import { BanditService } from "./bandit/service.ts";
import { policyFacts } from "./agent/answer.ts";

// TODO(tiger-data): swap in the Timescale-backed TripStore when it's ready.
const store = new InMemoryTripStore();
const { onPhone, onChat, onRiskEvaluation, setInsights } = createOrchestrator(store);

// Risk engine REST API; needs Postgres.
let riskRoutes: ReturnType<typeof createRiskRoutes> | undefined;
if (config.databaseUrl) {
  const riskStore = new PgRiskStore(new pg.Pool({ connectionString: config.databaseUrl }));
  await riskStore.migrate();
  let bandit: BanditService | undefined;
  if (config.tigerDatabaseUrl) {
    const banditStore = new PgBanditStore(new pg.Pool({ connectionString: config.tigerDatabaseUrl }));
    await banditStore.migrate();
    bandit = new BanditService(banditStore, undefined, () => Boolean(config.elevenLabs.familyVoiceId));
  }
  const riskService = new RiskService(riskStore, undefined, (_tripId, ev, intervention) => onRiskEvaluation(ev, intervention), bandit);
  // The driver id the phone sends to the REST API is the driver's name.
  if (bandit) setInsights(async () => policyFacts(trip.driverName, await riskService.driverPolicy(trip.driverName)));
  riskRoutes = createRiskRoutes(riskService);
  console.log(`[risk] REST API enabled (Postgres), adaptive recommendations ${bandit ? "on (Tiger Data)" : "off (TIGER_DATABASE_URL not set)"}`);
} else {
  console.log("[risk] REST API disabled (DATABASE_URL not set)");
}

startPhoneServer(config.port, onPhone, () => ({
  tripActive: trip.active,
  sharingMode: trip.sharingMode,
  latestR: trip.latest?.R ?? null,
  roastActive: roast.active,
  queued: driverQueue.length,
  groupChatKnown: hasGroup(),
}), riskRoutes);

if (process.env.NO_SPECTRUM) {
  console.log("[spectrum] skipped (NO_SPECTRUM set)");
} else {
  await startSpectrum(onChat);
}
