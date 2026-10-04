// Applies sql/01_schema.sql, sql/02_seed.sql and sql/03_policies.sql to DATABASE_URL (Tiger Data). The schema runs one
// statement at a time: continuous aggregates can't be created inside a transaction, which a
// multi-statement query would be. The seed runs as one query (it has ";" inside strings and no
// aggregates). Both files are idempotent, so re-running is safe.
//   npm run db:schema
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (backend/.env)");
  process.exit(1);
}

const read = (file: string) => readFileSync(new URL(`../../sql/${file}`, import.meta.url), "utf8");

/** Statements of a .sql file: comment lines dropped, split on ";" (01_schema.sql keeps semicolons out of strings). */
const statements = (file: string) =>
  read(file)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
await client.connect();
let failed = 0;
const schema = statements("01_schema.sql");
for (const sql of schema) {
  try {
    await client.query(sql);
  } catch (err) {
    failed++;
    console.error(`[01_schema.sql] ${(err as Error).message}\n  in: ${sql.split("\n")[0]!.slice(0, 100)}`);
  }
}
console.log(`01_schema.sql: ${schema.length} statements run`);
try {
  await client.query(read("02_seed.sql"));
  console.log("02_seed.sql: seeded");
} catch (err) {
  failed++;
  console.error(`[02_seed.sql] ${(err as Error).message}`);
}
const policies = statements("03_policies.sql");
for (const sql of policies) {
  try {
    await client.query(sql);
  } catch (err) {
    failed++;
    console.error(`[03_policies.sql] ${(err as Error).message}\n  in: ${sql.split("\n")[0]!.slice(0, 100)}`);
  }
}
console.log(`03_policies.sql: ${policies.length} statements run`);
const tables = await client.query(
  `SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`,
).catch(() => ({ rows: [] as { hypertable_name: string }[] }));
console.log(`hypertables: ${tables.rows.map((r) => r.hypertable_name).join(", ") || "none"}`);
await client.end();
process.exit(failed ? 1 : 0);
