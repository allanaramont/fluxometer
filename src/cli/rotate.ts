import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { setEnvLine } from "./envFile.js";
import {
  createReadonlyRole,
  readFileOrEmpty,
  setGitHubSecret,
  writeSecretFile,
  type ExecFileFn,
  type FsLike,
  type MissingDatabaseUrlError,
} from "./init.js";

export type RunRotateOptions = {
  env: NodeJS.ProcessEnv;
  fs: FsLike;
  execFile?: ExecFileFn;
};

export type RunRotateResult = {
  newReadonlyUrl: string | undefined;
  newCronSecret: string;
};

export async function runRotate(
  opts: RunRotateOptions,
): Promise<RunRotateResult> {
  const databaseUrl = opts.env.DATABASE_URL;
  if (!databaseUrl) {
    const error: MissingDatabaseUrlError = {
      code: "missing_database_url",
      message:
        "DATABASE_URL is not set. Set it and run `fluxometer rotate` again.",
    };
    throw error;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // createReadonlyRole always sets a fresh password — calling it again
    // IS the rotation, no separate drop/recreate step needed.
    const newReadonlyUrl = await createReadonlyRole(pool, databaseUrl);
    const newCronSecret = randomBytes(32).toString("hex");
    await setGitHubSecret(
      "FLUXOMETER_CRON_SECRET",
      newCronSecret,
      opts.execFile,
    );

    const existing = await readFileOrEmpty(opts.fs, ".env");
    let updated = setEnvLine(existing, "FLUXOMETER_CRON_SECRET", newCronSecret);
    if (newReadonlyUrl) {
      updated = setEnvLine(updated, "FLUXOMETER_READONLY_URL", newReadonlyUrl);
    }
    await writeSecretFile(opts.fs, ".env", updated);

    if (!newReadonlyUrl) {
      // The cron secret above DID rotate successfully — that write already
      // landed. This failure is reported on its own rather than silently
      // claiming a full rotation that didn't happen.
      throw new Error(
        "fluxometer: cron secret rotated, but the readonly role could not be rotated automatically — see the warning above for the SQL to run yourself.",
      );
    }

    return { newReadonlyUrl, newCronSecret };
  } finally {
    await pool.end();
  }
}

/** A message safe to print to stdout/CI logs — never includes the secret
 * itself, only confirms where it landed. */
export function describeRotateResult(result: RunRotateResult): string {
  return (
    "fluxometer: rotated. New cron secret written to .env." +
    (result.newReadonlyUrl ? " New readonly URL written to .env." : "")
  );
}
