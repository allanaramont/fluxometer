import { Pool } from "pg";

let pool: Pool | undefined;
const pending = new Set<Promise<unknown>>();

/** Lazily creates a small dedicated pool on first use. Never opens a
 * connection eagerly, and never competes with the host app's own pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }
  return pool;
}

export function setPoolForTesting(testPool: Pool): void {
  pool = testPool;
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
