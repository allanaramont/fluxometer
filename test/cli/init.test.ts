import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createReadonlyRole,
  type FsLike,
  runInit,
  setGitHubSecret,
} from "../../src/cli/init.js";

const HEX_64 = /[0-9a-f]{64}/i;

function createFakeFs(opts: { files?: Record<string, string> } = {}): FsLike & {
  readFile: (path: string) => string;
  warnings: string[];
} {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  const writeFile = vi.fn(async (path: string, content: string) => {
    files.set(path, content);
  });
  const chmod = vi.fn(async () => undefined);

  return {
    warnings,
    writeFile,
    chmod,
    // Synchronous for easy test assertions — `await` on a plain value is a
    // no-op, so production code's `await opts.fs.readFile(...)` still works.
    readFile: ((path: string) =>
      files.get(path) ?? "") as unknown as FsLike["readFile"],
    mkdir: (async () => undefined) as FsLike["mkdir"],
  } as unknown as FsLike & {
    readFile: (path: string) => string;
    writeFile: typeof writeFile;
    chmod: typeof chmod;
    warnings: string[];
  };
}

describe("runInit", () => {
  it("exits with a clear message and does not touch the database when DATABASE_URL is missing", async () => {
    const fakeFs = createFakeFs();
    await expect(
      runInit({ prompt: vi.fn(), env: {}, fs: fakeFs }),
    ).rejects.toMatchObject({ code: "missing_database_url" });
  });

  it("creates the schema, merges .env entries without touching unrelated keys, generates the workflow file, never overwrites an existing vercel.json, and warns if .env is not gitignored", async () => {
    const fakeFs = createFakeFs({
      files: {
        ".gitignore": "node_modules\n",
        ".env": "DATABASE_URL=keep-me\nOTHER_APP_SECRET=keep-me-too\n",
        "vercel.json": '{"functions":{"keep":"me"}}',
      },
    });
    const prompt = vi
      .fn()
      .mockResolvedValue("https://hooks.slack.com/services/x");
    const execFile = vi
      .fn()
      .mockRejectedValue(new Error("gh not available in test"));

    await runInit({
      prompt,
      env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
      fs: fakeFs,
      execFile,
    });

    const envContent = fakeFs.readFile(".env");
    expect(envContent).toContain("DATABASE_URL=keep-me");
    expect(envContent).toContain("OTHER_APP_SECRET=keep-me-too");
    expect(envContent).toContain("FLUXOMETER_SLACK_WEBHOOK_URL");
    expect(
      fakeFs.readFile(".github/workflows/fluxometer-report.yml"),
    ).toContain("schedule");
    // The user's own vercel.json (routes, functions, etc.) must survive —
    // the cron snippet goes to its own file instead.
    expect(fakeFs.readFile("vercel.json")).toBe('{"functions":{"keep":"me"}}');
    expect(fakeFs.readFile("fluxometer.vercel-cron.json")).toContain("crons");
    expect(fakeFs.warnings).toContainEqual(
      expect.stringMatching(/\.env.*gitignore/i),
    );
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
      ".env",
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
    // writeFile's mode option is a no-op for a pre-existing file (O_CREAT
    // only applies it on creation) — permissions must be enforced again.
    expect(fakeFs.chmod).toHaveBeenCalledWith(".env", 0o600);
  });

  it("never logs the generated password when role creation fails", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const brokenPool = {
      query: () => Promise.reject(new Error("permission denied")),
    } as unknown as Pool;

    const result = await createReadonlyRole(brokenPool, "postgres://x/y");

    expect(result).toBeUndefined();
    const combined = warnings.join("\n");
    expect(combined).not.toMatch(HEX_64);
    expect(combined).toContain("<CHOOSE_A_PASSWORD>");
  });

  it("includes the Postgres error code (SQLSTATE) in the fallback warning, to help diagnose permission vs. connectivity failures", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const permissionDenied = Object.assign(new Error("permission denied"), {
      code: "42501",
    });
    const brokenPool = {
      query: () => Promise.reject(permissionDenied),
    } as unknown as Pool;

    await createReadonlyRole(brokenPool, "postgres://x/y");

    expect(warnings.join("\n")).toContain("42501");
  });

  it("sets the role's actual password on every call, even when the role already exists from a previous run", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      // Ensure the role already exists before this test's first call, so
      // the second call below exercises the "role already exists" branch.
      await createReadonlyRole(pool, process.env.TEST_DATABASE_URL!);

      const querySpy = vi.spyOn(pool, "query");
      const secondUrl = await createReadonlyRole(
        pool,
        process.env.TEST_DATABASE_URL!,
      );

      const statements = querySpy.mock.calls.map((call) => String(call[0]));
      const passwordFromUrl = new URL(secondUrl!).password;
      expect(
        statements.some(
          (sql) =>
            /alter role fluxometer_readonly/i.test(sql) &&
            sql.includes(passwordFromUrl),
        ),
      ).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("never logs the cron secret when setting the GitHub secret fails", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const secret = "a".repeat(64);
    // Injected rather than shelling out to a real `gh` — a real call would
    // write/overwrite an Actions secret on whatever repo the test happens
    // to run inside.
    const failingExec = vi
      .fn()
      .mockRejectedValue(new Error("gh: not authenticated"));

    await setGitHubSecret("FLUXOMETER_CRON_SECRET", secret, failingExec);

    expect(failingExec).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["secret", "set"]),
      secret,
    );
    const combined = warnings.join("\n");
    expect(combined).not.toContain(secret);
  });

  it("passes the secret via stdin (--body-file -), never as a command-line argument readable via ps", async () => {
    const secret = "b".repeat(64);
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await setGitHubSecret("FLUXOMETER_CRON_SECRET", secret, exec);

    const [, args, input] = exec.mock.calls[0]!;
    expect(args).not.toContain(secret);
    expect(args).toEqual(
      expect.arrayContaining([
        "secret",
        "set",
        "FLUXOMETER_CRON_SECRET",
        "--body-file",
        "-",
      ]),
    );
    expect(input).toBe(secret);
  });
});
