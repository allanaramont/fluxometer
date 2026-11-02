import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import { runMigration } from "../core/schema.js";
import { setEnvLine } from "./envFile.js";
import { githubActionsTemplate, vercelCronTemplate } from "./templates.js";

export type ExecFileFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(execFile);

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
  chmod: (path: string, mode: number) => Promise<void>;
};

/** Writes a secret-bearing file and locks it down to owner-only
 * read/write. `writeFile`'s own `mode` option only applies when the file
 * is newly created — Postgres `O_CREAT` semantics mean it's silently
 * ignored for a file that already exists — so permissions are always
 * enforced again afterwards with an explicit `chmod`. */
export async function writeSecretFile(
  fs: FsLike,
  path: string,
  content: string,
): Promise<void> {
  await fs.writeFile(path, content, { mode: 0o600 });
  await fs.chmod(path, 0o600);
}

export type RunInitOptions = {
  prompt: (question: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  fs: FsLike;
  execFile?: ExecFileFn;
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
): Promise<string | undefined> {
  const password = randomBytes(32).toString("hex");
  try {
    const { rows } = await pool.query(
      `select 1 from pg_roles where rolname = 'fluxometer_readonly'`,
    );
    if (rows.length === 0) {
      await pool.query(
        `create role fluxometer_readonly login password '${password}'`,
      );
    } else {
      // The role already exists (a previous init/rotate ran) — there is no
      // way to read an existing password back out of Postgres, so every
      // call sets a fresh one. This also IS the rotation: calling this
      // again is how `runRotate` invalidates the old credential.
      await pool.query(
        `alter role fluxometer_readonly with login password '${password}'`,
      );
    }
    await pool.query(`grant usage on schema fluxometer to fluxometer_readonly`);
    await pool.query(
      `grant select on all tables in schema fluxometer to fluxometer_readonly`,
    );
    // Keeps a future table (this plan already added one — deploy_markers)
    // visible to the role without a manual re-grant.
    await pool.query(
      `alter default privileges in schema fluxometer grant select on tables to fluxometer_readonly`,
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
  exec: ExecFileFn = defaultExecFile,
): Promise<void> {
  try {
    await exec("gh", ["secret", "set", name, "--body", value]);
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
  const exec = opts.execFile ?? defaultExecFile;

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMigration(pool);

    const webhookUrl = await opts.prompt(
      "Slack incoming webhook URL (create one at https://api.slack.com/apps -> Incoming Webhooks): ",
    );
    const reportUrl = await opts.prompt(
      "Public URL that will receive the daily report (e.g. https://yourapp.com/api/fluxometer/report): ",
    );
    const readonlyUrl = await createReadonlyRole(pool, databaseUrl);
    const cronSecret = randomBytes(32).toString("hex");
    await setGitHubSecret("FLUXOMETER_CRON_SECRET", cronSecret, exec);
    if (reportUrl) {
      await setGitHubSecret("FLUXOMETER_REPORT_URL", reportUrl, exec);
    }

    // Merge into any existing .env — this is the app's own file and may
    // already hold DATABASE_URL and unrelated secrets that must survive.
    const existingEnv = await readFileOrEmpty(opts.fs, ".env");
    let updatedEnv = setEnvLine(
      existingEnv,
      "FLUXOMETER_SLACK_WEBHOOK_URL",
      webhookUrl,
    );
    updatedEnv = setEnvLine(updatedEnv, "FLUXOMETER_CRON_SECRET", cronSecret);
    if (reportUrl) {
      updatedEnv = setEnvLine(updatedEnv, "FLUXOMETER_REPORT_URL", reportUrl);
    }
    if (readonlyUrl) {
      updatedEnv = setEnvLine(
        updatedEnv,
        "FLUXOMETER_READONLY_URL",
        readonlyUrl,
      );
    }
    await writeSecretFile(opts.fs, ".env", updatedEnv);

    await opts.fs.mkdir(".github/workflows", { recursive: true });
    await opts.fs.writeFile(
      ".github/workflows/fluxometer-report.yml",
      githubActionsTemplate(),
    );
    // Never opts.fs.writeFile("vercel.json", ...) — that file is the host
    // app's own Vercel config (routes, functions, regions...) and this
    // package has no business overwriting it. The cron snippet goes to
    // its own file; the README shows how to merge it by hand.
    await opts.fs.writeFile(
      "fluxometer.vercel-cron.json",
      vercelCronTemplate(),
    );

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
