import { defineConfig } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// 既存のハードコード日本語を含む負債ファイル（管理規約は scripts/i18n-debt-files.js 参照）。
// 移設完了ファイルはここから削除すること。
const i18nDebtFiles = require("./scripts/i18n-debt-files.js");

// ESLint の `files` は glob として評価されるため、負債リストのファイル名に含まれる
// globメタ文字をリテラルとしてエスケープする。動的ルートの `[streamerId]` を `*` に
// 置き換えると、同階層の未登録ファイルまで負債扱いになるため、登録された1ファイル
// だけに除外範囲を限定する。
const GLOB_META_CHARACTERS = /[\\*?\[\]{}()!+@]/g;
const globSafePath = (f) =>
  f
    .split("/")
    .map((seg) => seg.replace(GLOB_META_CHARACTERS, "\\$&"))
    .join("/");

/**
 * i18n ハードコード日本語の検出専用 ESLint 設定（#835）。
 *
 * 本体の eslint.config.mjs には含めず、`npm run lint:i18n`（ci.yml の専用ジョブ）でのみ
 * 実行する。理由: 既存コードには大量のハードコード日本語が残っており（負債リスト
 * scripts/i18n-debt-files.js 参照）、本体設定に入れると既存の 16k 件の lint エラーに埋もれる。
 * この設定は「移設完了ファイル = 負債リストに無いファイル」に対してのみ
 * 日本語リテラルがゼロであることを強制する。
 *
 * 検出対象:
 * - 文字列リテラル・テンプレートリテラル・JSX テキストノード内の
 *   ひらがな/カタカナ/CJK漢字（基本+拡張A）
 * - コメント内の日本語は対象外（実行時に表示されないため）
 *
 * 負債リストの管理: ファイルの移設が完了したら scripts/i18n-debt-files.js から
 * そのファイルを削除すること。リストに無いファイルで日本語リテラルを追加すると CI が赤くなる。
 */
// ひらがな/カタカナ/CJK漢字（基本+拡張A）に加え、日本語文に必ず付随する
// 和文句読点・全角記号（、。「」〜※等）も検出対象に含める
// （「※」のみ・全角記号のみの文字列もハードコード日本語の一種として捕捉する）。
const JA_CHARS = "[\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65]";

// eslint-disable コメントで no-restricted-syntax を無効化すると検出をすり抜けられるが、
// これは意図的なソフトガード（完全な強制はプラグイン拡張が必要で YAGNI）。
// 回帰防止の主目的は「うっかり追加」の検出であり、意図的な無効化はコードレビューで担保する。

export default defineConfig([
  {
    files: ["src/**/*.{ts,tsx}"],
    linterOptions: {
      // 専用設定では react-hooks 等のルールを有効化しないため、コード内の
      // eslint-disable コメントが「未使用」扱いで警告になる。日本語リテラル検出が
      // この設定の唯一の責務なので、disable コメントの未使用警告は抑止する。
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      // コード内の eslint-disable コメント（react-hooks/exhaustive-deps や
      // @typescript-eslint/xxx 等）がルール定義無しでエラーにならないよう、
      // 参照されうるプラグインのみ登録する（ルール自体は有効化しない。
      // 日本語リテラル検出がこの設定の唯一の責務）。
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
      "@typescript-eslint": tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      sourceType: "module",
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${JA_CHARS}/]`,
          message: "日本語リテラルは messages/*.json のキーへ移設してください",
        },
        {
          selector: `TemplateElement[value.cooked=/${JA_CHARS}/]`,
          message: "日本語テンプレートは messages/*.json のキーへ移設してください",
        },
        {
          selector: `JSXText[value=/${JA_CHARS}/]`,
          message: "JSX テキストノードの日本語は messages/*.json のキーへ移設してください",
        },
      ],
    },
  },
  {
    // 負債ファイルは検査対象から除外（後勝ちで no-restricted-syntax を無効化する。
    // 移設完了時に i18n-debt-files.js から削除すると、このブロックの適用範囲から外れて検査が復活する）
    files: i18nDebtFiles.map((f) => `**/${globSafePath(f)}`),
    rules: {
      "no-restricted-syntax": "off",
    },
  },
]);
