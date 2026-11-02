import { describe, expect, it } from "vitest";
import type { FsLike } from "../../src/cli/init.js";
import { runRotate } from "../../src/cli/rotate.js";

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
});
