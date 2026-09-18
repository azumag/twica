import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated artifacts created by local build / deploy tooling
    ".open-next/**",
    ".wrangler/**",
    "workers/*/dist/**",
    // Agent worktrees / scratch clones are intentionally git-ignored, but ESLint flat config
    // does not consume .gitignore. Keep `eslint .` from recursively linting unrelated local
    // checkouts or test scratch repositories that can contain their own generated artifacts.
    ".claude/worktrees/**",
    ".codex-*/**",
    "twica-maker-*/**",
    ".tmp-i18n-static-keys-*/**",
    // Exclude analysis directory (separate project with bundled artifacts)
    // analysis ディレクトリを除外（バンドル済み成果物を含む別プロジェクト）
    "analysis/**",
  ]),
  {
    // テストファイルではモックの型付けで any が必要なため許可
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
