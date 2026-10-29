import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running migrations.");
const here = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });

try {
  await pool.query("CREATE TABLE IF NOT EXISTS foodlens_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const name = "001_customer_accounts.sql";
  const applied = await pool.query("SELECT 1 FROM foodlens_schema_migrations WHERE name = $1", [name]);
  if (applied.rowCount) {
    console.log(`${name} already applied`);
  } else {
    const sql = await readFile(join(here, "..", "migrations", name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO foodlens_schema_migrations(name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
} finally {
  await pool.end();
}
