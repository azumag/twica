import { describe, expect, it } from 'vitest'
import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import eslintI18nConfig from '../../eslint.i18n.config.mjs'

/**
 * eslint.i18n.config.mjs（#835 の日本語リテラル検出専用設定）の動作テスト。
 *
 * 負債リスト（scripts/i18n-debt-files.js）に無いファイルで日本語リテラルを追加すると
 * CI（lint-i18n ジョブ）が失敗する仕組みが、意図どおり機能することを固定する。
 */
const linter = new Linter()

function lint(code: string) {
  // 設定の負債リスト除外はパスベースのため、Linter API では適用されない。
  // ここでは「検出ルール本体」の動作のみを検証する（負債除外の動作は npm run lint:i18n が担保）。
  return linter.verify(code, [
    {
      plugins: eslintI18nConfig[0].plugins,
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaFeatures: { jsx: true } },
        sourceType: 'module',
      },
      rules: eslintI18nConfig[0].rules,
    },
  ])
}

describe('eslint.i18n.config.mjs（日本語リテラル検出）', () => {
  it('文字列リテラル内の日本語を検出する', () => {
    const result = lint('const message = "エラーが発生しました";')
    expect(result.some((r) => r.ruleId === 'no-restricted-syntax')).toBe(true)
  })

  it('テンプレートリテラル内の日本語を検出する', () => {
    const result = lint('const message = `操作に失敗しました: ${reason}`;')
    expect(result.some((r) => r.ruleId === 'no-restricted-syntax')).toBe(true)
  })

  it('JSX テキストノード内の日本語を検出する', () => {
    const result = lint('export const C = () => <span>開く</span>;')
    expect(result.some((r) => r.ruleId === 'no-restricted-syntax')).toBe(true)
  })

  it('ASCII のみのコードは検出しない', () => {
    const result = lint('const message = "An error occurred"; const t = "hello";')
    expect(result.filter((r) => r.ruleId === 'no-restricted-syntax')).toEqual([])
  })

  it('コメント内の日本語は検出しない（実行時に表示されないため）', () => {
    const result = lint('// コメント内の日本語は検出しない\nconst message = "ok";')
    expect(result.filter((r) => r.ruleId === 'no-restricted-syntax')).toEqual([])
  })
})
