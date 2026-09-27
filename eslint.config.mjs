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
    // HTML 文字列を DOM に挿入する API（XSS シンク）を禁止する。
    // 背景: 脆弱なチャットオーバーレイが視聴者のメッセージを HTML として挿入し、
    // OBS Browser Source（sandbox 無効・旧 CEF）上で CVE-2024-7971 経由の
    // ネイティブコード実行に繋がった事例がある（OBS Studio 32.2.2 以前）。
    // twica の /overlay も OBS Browser Source で動き、視聴者名など外部由来の
    // 文字列を描画するため、React のテキスト描画（自動エスケープ）以外の経路を
    // 静的に塞ぐ。OWASP XSS Prevention Cheat Sheet の「危険なシンクを使わない」
    // 方針に従い、現状 0 件の状態を lint で固定する。
    files: ["src/**/*.{ts,tsx}", "workers/**/*.ts"],
    rules: {
      "react/no-danger": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
          message:
            "innerHTML/outerHTML への代入は XSS シンクです。textContent か React のテキスト描画を使ってください。",
        },
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name=/^(insertAdjacentHTML|createContextualFragment)$/]",
          message:
            "HTML 文字列を解釈する API は XSS シンクです。DOM API（textContent 等）か React のテキスト描画を使ってください。",
        },
        {
          // WritableStream#write 等を誤検知しないよう document に限定する
          selector:
            "CallExpression > MemberExpression.callee[object.name='document'][property.name=/^(write|writeln)$/]",
          message:
            "HTML 文字列を解釈する API は XSS シンクです。DOM API（textContent 等）か React のテキスト描画を使ってください。",
        },
      ],
    },
  },
  {
    // テストファイルではモックの型付けで any が必要なため許可
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
