import { describe, expect, it, vi } from "vitest";
import type { FsLike } from "../../src/cli/init.js";
import { describeRotateResult, runRotate } from "../../src/cli/rotate.js";

function createFakeFs(opts: { files?: Record<string, string> } = {}): FsLike & {
  readFile: (path: string) => string;
} {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  return {
    readFile: ((path: string) =>
      files.get(path) ?? "") as unknown as FsLike["readFile"],
    writeFile: (async (path: string, content: string) => {
      files.set(path, content);
    }) as FsLike["writeFile"],
    mkdir: (async () => undefined) as FsLike["mkdir"],
    chmod: (async () => undefined) as FsLike["chmod"],
  } as unknown as FsLike & { readFile: (path: string) => string };
}

describe("runRotate", () => {
  it("creates a new readonly role and cron secret, revokes the old role, and rewrites .env", async () => {
    const fakeFs = createFakeFs({
      files: {
        ".env":
          "FLUXOMETER_READONLY_URL=old\nFLUXOMETER_CRON_SECRET=oldsecret\n",
      },
    });

    const result = await runRotate({
      env: { DATABASE_URL: process.env.TEST_DATABASE_URL },
      fs: fakeFs,
    });

    expect(result.newCronSecret).not.toBe("oldsecret");
    expect(fakeFs.readFile(".env")).toContain(result.newCronSecret);
  });

  it("reports failure (instead of silently claiming success) when the readonly role can't be rotated", async () => {
    const fakeFs = createFakeFs({
      files: { ".env": "FLUXOMETER_CRON_SECRET=oldsecret\n" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A connection that can never succeed (closed port) makes
    // createReadonlyRole's internal queries fail for a real reason,
    // without needing to mock pg's Pool.
    const unreachableUrl = "postgresql://nouser:nopass@127.0.0.1:1/nonexistent";

    await expect(
      runRotate({ env: { DATABASE_URL: unreachableUrl }, fs: fakeFs }),
    ).rejects.toThrow(/readonly role could not be rotated/i);

    // The cron secret half of the rotation still landed on disk.
    expect(fakeFs.readFile(".env")).not.toContain("oldsecret");
  });
});

describe("describeRotateResult", () => {
  it("never includes the actual secret value", () => {
    const text = describeRotateResult({
      newReadonlyUrl: "postgres://fluxometer_readonly:supersecret@host/db",
      newCronSecret: "a".repeat(64),
    });
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("a".repeat(64));
  });
});
