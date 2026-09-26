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
    // Exclude analysis directory (separate project with bundled artifacts)
    // analysis ディレクトリを除外（バンドル済み成果物を含む別プロジェクト）
    "analysis/**",
  ]),
  {
    // DOM XSS シンクの禁止（退行ガード）。
    // 背景: OBS ブラウザソース（CEF）は Chromium サンドボックス無効で動き、
    // 同梱 V8 が古いと「視聴者由来文字列が HTML として挿入される XSS」→
    // 「V8 脆弱性（例: CVE-2024-7971）」→「配信者PCでネイティブコード実行」
    // へ連鎖する（OBS × Twitch チャット経由のコード実行として報告された攻撃）。TwiCa のオーバーレイは
    // 視聴者の Twitch 名などを描画するため、この連鎖の入口になり得る。
    // 対策の業界標準（OWASP DOM based XSS Prevention Cheat Sheet）は
    // 「信頼できない値はテキストとして挿入し、HTML を解釈するシンクを使わない」。
    // React の JSX テキスト描画は自動エスケープされるので、エスケープを
    // 迂回する API だけをここで一律禁止する。現状の使用箇所は 0 件であり、
    // 本当に必要になった場合は sanitize 方針をレビューしたうえで行単位の
    // eslint-disable と理由コメントを付けること。
    // CSP（nonce + strict-dynamic, src/lib/security-headers.ts）が第2層の防御。
    files: ["src/**/*.{ts,tsx}", "workers/**/*.ts"],
    rules: {
      // JSX の自動エスケープを迂回する唯一の React API
      "react/no-danger": "error",
      // 文字列をコードとして評価する API（XSS 成立後の足場・CSP 回避の典型）
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      // 文字列を HTML として解釈する DOM API
      "no-restricted-properties": [
        "error",
        // createContextualFragment は range インスタンス経由で呼ばれるため
        // object を指定せずプロパティ名だけで検知する
        ...["innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc", "createContextualFragment"].map((property) => ({
          property,
          message: "HTML として解釈される DOM シンクは禁止（XSS 対策）。textContent か JSX テキストを使うこと。",
        })),
        ...["write", "writeln"].map((property) => ({
          object: "document",
          property,
          message: "document.write は HTML として解釈される DOM シンクのため禁止（XSS 対策）。",
        })),
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
