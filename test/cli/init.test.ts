import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  createReadonlyRole,
  runInit,
  setGitHubSecret,
  type FsLike,
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

  return {
    warnings,
    writeFile,
    // Synchronous for easy test assertions — `await` on a plain value is a
    // no-op, so production code's `await opts.fs.readFile(...)` still works.
    readFile: ((path: string) =>
      files.get(path) ?? "") as unknown as FsLike["readFile"],
    mkdir: (async () => undefined) as FsLike["mkdir"],
  } as unknown as FsLike & {
    readFile: (path: string) => string;
    writeFile: typeof writeFile;
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

  it("creates the schema, writes .env entries, generates the workflow file, and warns if .env is not gitignored", async () => {
    const fakeFs = createFakeFs({ files: { ".gitignore": "node_modules\n" } });
    const prompt = vi
      .fn()
      .mockResolvedValue("https://hooks.slack.com/services/x");

    await runInit({
      prompt,
      env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
      fs: fakeFs,
    });

    expect(fakeFs.readFile(".env")).toContain("FLUXOMETER_SLACK_WEBHOOK_URL");
    expect(
      fakeFs.readFile(".github/workflows/fluxometer-report.yml"),
    ).toContain("schedule");
    expect(fakeFs.warnings).toContainEqual(
      expect.stringMatching(/\.env.*gitignore/i),
    );
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
      ".env",
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
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

  it("never logs the cron secret when setting the GitHub secret fails", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const secret = "a".repeat(64);

    await setGitHubSecret("FLUXOMETER_CRON_SECRET", secret);

    const combined = warnings.join("\n");
    expect(combined).not.toContain(secret);
  });
});
