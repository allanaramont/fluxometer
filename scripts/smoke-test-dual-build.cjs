// Confirms package.json's `exports` map actually works for a CommonJS
// consumer, end to end - unit tests run against TS source via vitest's
// own transform and never exercise the published dist/exports wiring.
// Self-references the package by its own name (Node resolves this via
// the nearest ancestor package.json without needing node_modules).
// Run after `npm run build`, which is what makes dist/cjs exist.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS file, require() is the point of the test
const assert = require("node:assert");

for (const subpath of ["express", "fastify", "next", "report", "migrate"]) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- proving a real CJS consumer's require() resolves
  const mod = require(`fluxometer/${subpath}`);
  assert.ok(mod && typeof mod === "object", `CJS require of ${subpath} failed`);
}

console.log("smoke-test-dual-build: CJS requires resolved cleanly");
