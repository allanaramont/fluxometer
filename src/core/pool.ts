import { Pool } from "pg";

let pool: Pool | undefined;
const pending = new Set<Promise<unknown>>();

/** Lazily creates a small dedicated pool on first use. Never opens a
 * connection eagerly, and never competes with the host app's own pool.
 *
 * Does not throw when `DATABASE_URL` is missing — this is called from
 * the fire-and-forget write path, which must never throw into the host
 * app. Instead it warns once with a clear message, so the connection
 * failure that follows reads as "DATABASE_URL is missing" rather than an
 * unrelated-looking Postgres error (e.g. "database \"<os-user>\" does
 * not exist", from `pg`'s own OS-user fallback). */
export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.warn(
        "fluxometer: DATABASE_URL is not set — connecting with pg's default fallback, which is almost certainly not what you want.",
      );
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }
  return pool;
}

export function setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function resetPoolForTesting(): void {
  pool = undefined;
}

/** Registers a fire-and-forget write so flushForTesting can wait on it. */
export function trackPending(promise: Promise<unknown>): void {
  pending.add(promise);
  void promise.finally(() => pending.delete(promise));
}

/** Test seam: waits for every in-flight fire-and-forget write to settle. */
export async function flushForTesting(): Promise<void> {
  await Promise.allSettled([...pending]);
}
