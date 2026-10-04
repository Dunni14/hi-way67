// Guards drift between the app's idempotent schema (store/schema.ts) and the Tiger-side
// backend/sql/01_schema.sql: every column the app creates must exist in the SQL file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMA_SQL } from "./store/schema.ts";

const columns = (sql: string, table: string): string[] => {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(sql);
  assert.ok(m, `table ${table} not found`);
  return m[1]!
    .split("\n")
    .map((l) => /^\s{2}([a-z_0-9]+)\s+[A-Za-z]/.exec(l)?.[1])
    .filter((c): c is string => !!c && !["primary", "check"].includes(c.toLowerCase()));
};

const file = readFileSync(new URL("../../sql/01_schema.sql", import.meta.url), "utf8");

for (const table of ["drivers", "trips", "windows", "events", "observations", "report_cards", "bandit_events", "gps_samples"]) {
  test(`schema.ts and sql/01_schema.sql agree on ${table}`, () => {
    const app = columns(SCHEMA_SQL, table).sort();
    const sql = columns(file, table).sort();
    assert.deepEqual(app, sql);
  });
}
