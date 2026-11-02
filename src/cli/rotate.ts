import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  createReadonlyRole,
  readFileOrEmpty,
  type FsLike,
  type MissingDatabaseUrlError,
} from "./init.js";

export type RunRotateOptions = {
  env: NodeJS.ProcessEnv;
  fs: FsLike;
};

export type RunRotateResult = {
  newReadonlyUrl: string | undefined;
  newCronSecret: string;
};

function setEnvLine(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return content.length > 0 && !content.endsWith("\n")
    ? `${content}\n${line}\n`
    : `${content}${line}\n`;
}

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
    const newReadonlyUrl = await createReadonlyRole(pool, databaseUrl, {
      forceRecreate: true,
    });
    const newCronSecret = randomBytes(32).toString("hex");

    const existing = await readFileOrEmpty(opts.fs, ".env");
    let updated = setEnvLine(existing, "FLUXOMETER_CRON_SECRET", newCronSecret);
    if (newReadonlyUrl) {
      updated = setEnvLine(updated, "FLUXOMETER_READONLY_URL", newReadonlyUrl);
    }
    await opts.fs.writeFile(".env", updated, { mode: 0o600 });

    return { newReadonlyUrl, newCronSecret };
  } finally {
    await pool.end();
  }
}
