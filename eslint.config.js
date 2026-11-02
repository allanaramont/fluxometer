import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

// import/no-cycle is intentionally not configured: every maintained
// ESLint-9/10-compatible import-cycle plugin tried here (eslint-plugin-
// import, its eslint-plugin-import-x fork) pulls a minimatch major that
// either fails npm's peer resolution or, once forced via `overrides`,
// breaks at runtime (eslint-plugin-import-x's no-internal-modules rule
// imports a `makeRe` export minimatch 11 removed). This repo has no
// circular imports today (verified manually); re-add the rule once the
// ecosystem catches up rather than forcing a broken dependency now.
export default tseslint.config(
  {
    ignores: ["dist/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Test doubles routinely need `any` (fake fs/pool shapes, mock
      // call args) — the project's own rule for this is "any in tests is
      // fine", not "no any anywhere".
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
