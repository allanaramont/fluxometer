import { describe, expect, it, vi } from "vitest";
import { runInit, type FsLike } from "../../src/cli/init.js";

function createFakeFs(opts: { files?: Record<string, string> } = {}): FsLike & {
  readFile: (path: string) => string;
  warnings: string[];
} {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  return {
    warnings,
    // Synchronous for easy test assertions — `await` on a plain value is a
    // no-op, so production code's `await opts.fs.readFile(...)` still works.
    readFile: ((path: string) =>
      files.get(path) ?? "") as unknown as FsLike["readFile"],
    writeFile: (async (path: string, content: string) => {
      files.set(path, content);
    }) as FsLike["writeFile"],
    mkdir: (async () => undefined) as FsLike["mkdir"],
  } as unknown as FsLike & {
    readFile: (path: string) => string;
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
  });
});
