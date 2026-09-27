import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// XSS シンク禁止ルール（下の no-restricted-syntax）用の esquery 部品。
// メンバー名はドット記法（el.innerHTML）と文字列リテラルのブラケット記法
// （el['innerHTML']）で AST 上の格納先が異なる（Identifier.name / Literal.value）ため、
// 両方を照合しないと書き方ひとつで lint をすり抜ける。変数キー（el[key]）は
// 静的に名前が決まらないため対象外。
const memberKey = (path, pattern) =>
  `:matches([${path}.name=${pattern}], [${path}.value=${pattern}])`;
// 対象は MDN Trusted Types の TrustedHTML injection sink 一覧に揃える
// （https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API#injection_sink_interfaces）。
// 一覧を正本にすることで、レビューごとに sink を1つずつ追加する取りこぼしを避ける。
// - srcdoc: iframe 内で文字列を HTML としてパースし、sandbox 無しならスクリプトも実行される
// - parseFromString: DOMParser が文字列を HTML/XML 文書としてパースする
// - execCommand: 'insertHTML' が HTML sink。第1引数は動的になり得るため、非推奨 API ごと禁止する
const HTML_PROPS = "/^(innerHTML|outerHTML|srcdoc)$/";
const HTML_METHODS =
  "/^(insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|parseFromString|execCommand)$/";
const DOCUMENT_WRITE = "/^(write|writeln)$/";
const HTML_PARSING_API_MESSAGE =
  "HTML 文字列を解釈する API は XSS シンクです。DOM API（textContent 等）か React のテキスト描画を使ってください。";

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
          selector: `AssignmentExpression > MemberExpression.left${memberKey("property", HTML_PROPS)}`,
          message:
            "innerHTML/outerHTML/srcdoc への代入は XSS シンクです。textContent か React のテキスト描画を使ってください。",
        },
        {
          // React の <iframe srcDoc={...} /> は DOM の srcdoc 代入と同じ sink
          selector: "JSXAttribute[name.name=/^srcdoc$/i]",
          message:
            "srcDoc は文字列を HTML としてパースする XSS シンクです。iframe には src で同一オリジンのページを指定してください。",
        },
        {
          selector: `CallExpression > MemberExpression.callee${memberKey("property", HTML_METHODS)}`,
          message: HTML_PARSING_API_MESSAGE,
        },
        {
          // WritableStream#write 等を誤検知しないよう、レシーバが document の場合に限定する。
          // document.write / document['write'] に加え、window.document.write や
          // iframe.contentWindow['document'].write のように末尾が document のものも対象。
          selector: `CallExpression > MemberExpression.callee:matches([object.name='document'], [object.property.name='document'], [object.property.value='document'])${memberKey("property", DOCUMENT_WRITE)}`,
          message: HTML_PARSING_API_MESSAGE,
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
