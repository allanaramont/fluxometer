import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import { runMigration } from "../core/schema.js";
import { githubActionsTemplate, vercelCronTemplate } from "./templates.js";

const execFileAsync = promisify(execFile);

export type MissingDatabaseUrlError = {
  code: "missing_database_url";
  message: string;
};

/** The minimal filesystem surface `runInit` needs, satisfied in production
 * by `node:fs/promises` and in tests by a small in-memory fake. */
export type FsLike = {
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  writeFile: (
    path: string,
    content: string,
    opts?: { mode?: number },
  ) => Promise<void>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
};

export type RunInitOptions = {
  prompt: (question: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  fs: FsLike;
};

export async function readFileOrEmpty(
  fs: FsLike,
  path: string,
): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function createReadonlyRole(
  pool: Pool,
  databaseUrl: string,
  opts: { forceRecreate?: boolean } = {},
): Promise<string | undefined> {
  const password = randomBytes(32).toString("hex");
  try {
    if (opts.forceRecreate) {
      // Drops and recreates so the old password stops working immediately
      // — this is the whole point of a rotate. DROP OWNED BY first: a role
      // holding any grant can't be dropped directly in Postgres.
      await pool.query(`drop owned by fluxometer_readonly`);
      await pool.query(`drop role if exists fluxometer_readonly`);
    }
    const { rows } = await pool.query(
      `select 1 from pg_roles where rolname = 'fluxometer_readonly'`,
    );
    if (rows.length === 0) {
      await pool.query(
        `create role fluxometer_readonly login password '${password}'`,
      );
    }
    await pool.query(`grant usage on schema fluxometer to fluxometer_readonly`);
    await pool.query(
      `grant select on all tables in schema fluxometer to fluxometer_readonly`,
    );
    const url = new URL(databaseUrl);
    url.username = "fluxometer_readonly";
    url.password = password;
    return url.toString();
  } catch {
    // Never log the generated password, nor the underlying error (which may
    // itself echo connection details) — print a template the operator fills
    // in with their own password instead.
    console.warn(
      "fluxometer: could not create the readonly role automatically. Run this SQL yourself, choosing your own password:\n" +
        "  create role fluxometer_readonly login password '<CHOOSE_A_PASSWORD>';\n" +
        "  grant usage on schema fluxometer to fluxometer_readonly;\n" +
        "  grant select on all tables in schema fluxometer to fluxometer_readonly;",
    );
    return undefined;
  }
}

export async function setGitHubSecret(
  name: string,
  value: string,
): Promise<void> {
  try {
    await execFileAsync("gh", ["secret", "set", name, "--body", value]);
  } catch {
    // Never log the secret value itself — it was already written to .env;
    // point the operator there instead of printing it again.
    console.warn(
      `fluxometer: couldn't set ${name} via gh. It's in your .env file — set it as a CI secret yourself.`,
    );
  }
}

export async function runInit(opts: RunInitOptions): Promise<void> {
  const databaseUrl = opts.env.DATABASE_URL;
  if (!databaseUrl) {
    const error: MissingDatabaseUrlError = {
      code: "missing_database_url",
      message:
        "DATABASE_URL is not set. Set it to your app's Postgres connection string and run `fluxometer init` again.",
    };
    throw error;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMigration(pool);

    const webhookUrl = await opts.prompt(
      "Slack incoming webhook URL (create one at https://api.slack.com/apps -> Incoming Webhooks): ",
    );
    const readonlyUrl = await createReadonlyRole(pool, databaseUrl);
    const cronSecret = randomBytes(32).toString("hex");
    await setGitHubSecret("FLUXOMETER_CRON_SECRET", cronSecret);

    const envLines = [
      `FLUXOMETER_SLACK_WEBHOOK_URL=${webhookUrl}`,
      `FLUXOMETER_CRON_SECRET=${cronSecret}`,
      readonlyUrl ? `FLUXOMETER_READONLY_URL=${readonlyUrl}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    // 0600: these are secrets, not readable/writable by other local users.
    await opts.fs.writeFile(".env", `${envLines}\n`, { mode: 0o600 });

    await opts.fs.mkdir(".github/workflows", { recursive: true });
    await opts.fs.writeFile(
      ".github/workflows/fluxometer-report.yml",
      githubActionsTemplate(),
    );
    await opts.fs.writeFile("vercel.json", vercelCronTemplate());

    const gitignore = await readFileOrEmpty(opts.fs, ".gitignore");
    if (!/^\s*\.env\s*$/m.test(gitignore)) {
      console.warn(
        "fluxometer: .env is not listed in .gitignore — add it before committing.",
      );
    }
  } finally {
    await pool.end();
  }
}
