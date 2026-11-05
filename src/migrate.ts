import { Pool } from "pg";

import { runMigration, SCHEMA_NAME } from "./core/schema.js";

export { runMigration, SCHEMA_NAME };

/**
 * One-shot migration for host apps that don't want to depend on `pg`
 * directly or manage a `Pool`'s lifecycle just for this: opens a
 * short-lived connection, runs the idempotent schema migration, and
 * closes it. Safe to call on every build/deploy — every statement is
 * `if not exists`. Never falls back to `pg`'s OS-user default the way a
 * bare `new Pool()` would when `DATABASE_URL` is missing - that failure
 * mode reads as an unrelated Postgres error instead of a clear message.
 */
export async function migrate(
  connectionString: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  if (!connectionString) {
    throw new Error(
      "fluxometer: migrate() needs DATABASE_URL set, or an explicit connection string argument.",
    );
  }
  const pool = new Pool({ connectionString });
  try {
    await runMigration(pool);
  } finally {
    await pool.end();
  }
}
