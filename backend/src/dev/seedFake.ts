// Builds the fake database and prints what is in it. Run: npm run seed:fake
import { openFakeDb } from "./fakeDb.ts";

const { db, seeded } = await openFakeDb({ dir: process.env.FAKE_DB_DIR });
const q = async (sql: string) => (await db.query(sql)).rows;
console.log("seeded:", seeded);
console.table(await q(`SELECT driver_id, sharing_mode, count(*)::int AS trips FROM drivers JOIN trips USING (driver_id) GROUP BY 1, 2 ORDER BY 1`));
console.table(await q(`SELECT tier, count(*)::int AS windows FROM windows GROUP BY tier ORDER BY tier`));
console.table(await q(`SELECT tier, count(*)::int AS events FROM events GROUP BY tier ORDER BY tier`));
console.table(await q(`SELECT 'risk_factors' t, count(*)::int n FROM risk_factors UNION ALL SELECT 'settings', count(*)::int FROM settings UNION ALL SELECT 'bandit_actions', count(*)::int FROM bandit_actions`));
await db.close();
