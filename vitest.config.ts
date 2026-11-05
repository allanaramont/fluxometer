import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Many test files share one external TEST_DATABASE_URL and the same
    // fluxometer.* tables with no per-test isolation; running files in
    // parallel would let them corrupt each other's rows.
    fileParallelism: false,
    // Spies/mocks on shared module exports (e.g. slackSend.postToSlack)
    // must not leak their call history or implementation into the next
    // test — restoreMocks also implies clearMocks.
    restoreMocks: true,
    // `include` already scopes to test/**/*.test.ts, so this only needs
    // to carve out the one broken file - see the comment there for why.
    exclude: ["test/adapters/fastify.test.ts"],
  },
});
