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
  writeFile: (path: string, content: string) => Promise<void>;
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
  } catch (err) {
    console.warn(
      "fluxometer: could not create the readonly role automatically. Run this SQL yourself:\n" +
        `  create role fluxometer_readonly login password '${password}';\n` +
        "  grant usage on schema fluxometer to fluxometer_readonly;\n" +
        "  grant select on all tables in schema fluxometer to fluxometer_readonly;",
      err,
    );
    return undefined;
  }
}

async function setGitHubSecret(name: string, value: string): Promise<void> {
  try {
    await execFileAsync("gh", ["secret", "set", name, "--body", value]);
  } catch {
    console.warn(
      `fluxometer: couldn't set ${name} via gh. Add it to your CI secrets yourself: ${value}`,
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
    await opts.fs.writeFile(".env", `${envLines}\n`);

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
