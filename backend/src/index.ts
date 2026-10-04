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

// TODO(tiger-data): swap in the Timescale-backed TripStore when it's ready.
const store = new InMemoryTripStore();
const { onPhone, onChat, onRiskEvaluation } = createOrchestrator(store);

// Risk engine REST API; needs Postgres. FAKE_DB=1 or an unreachable DATABASE_URL uses the local seeded one.
async function openRiskStore(): Promise<PgRiskStore | undefined> {
  if (config.databaseUrl && !config.fakeDb) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      const real = new PgRiskStore(pool);
      await real.migrate();
      console.log("[risk] REST API enabled (Postgres)");
      return real;
    } catch (err) {
      console.warn(`[risk] DATABASE_URL unreachable (${(err as Error).message}); falling back to the local fake database`);
      await pool.end().catch(() => {});
    }
  } else if (!config.fakeDb) {
    return undefined;
  }
  const { openFakeDb } = await import("./dev/fakeDb.ts");
  const fake = await openFakeDb({ dir: config.fakeDbDir });
  console.log(`[risk] REST API enabled (fake in-process Postgres, ${fake.seeded.trips} trips / ${fake.seeded.windows} windows seeded)`);
  return fake.store;
}

let riskRoutes: ReturnType<typeof createRiskRoutes> | undefined;
const riskStore = await openRiskStore();
if (riskStore) {
  riskRoutes = createRiskRoutes(new RiskService(riskStore, undefined, (_tripId, ev, extra) => onRiskEvaluation(ev, extra)));
} else {
  console.log("[risk] REST API disabled (set DATABASE_URL or FAKE_DB=1)");
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
