import { describe, expect, it } from 'vitest'
import { ESLint, Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import eslintI18nConfig from '../../eslint.i18n.config.mjs'
import { resolve } from 'node:path'

/**
 * eslint.i18n.config.mjs（#835 の日本語リテラル検出専用設定）の動作テスト。
 *
 * 負債リスト（scripts/i18n-debt-files.js）に無いファイルで日本語リテラルを追加すると
 * CI（lint-i18n ジョブ）が失敗する仕組みが、意図どおり機能することを固定する。
 */
const linter = new Linter()
// Vitest transforms `import.meta.url` into a non-file module URL, so passing it to
// `fileURLToPath` is not portable. The test command runs from the repository root;
// resolving the known config filename from `process.cwd()` yields the absolute path
// ESLint requires without depending on the module URL scheme.
const i18nConfigPath = resolve(process.cwd(), 'eslint.i18n.config.mjs')

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

async function lintWithConfigFile(code: string, filePath: string) {
  const eslint = new ESLint({ overrideConfigFile: i18nConfigPath })
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages
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

  it('負債リストの動的ルートだけを除外し、同階層の未登録ファイルは検出する', async () => {
    const registeredRoute = await lintWithConfigFile(
      'const message = "既存の負債";',
      'src/app/overlay/[streamerId]/page.tsx'
    )
    const unregisteredSibling = await lintWithConfigFile(
      'const message = "新しい日本語";',
      'src/app/overlay/settings/page.tsx'
    )

    expect(registeredRoute.some((r) => r.ruleId === 'no-restricted-syntax')).toBe(false)
    expect(unregisteredSibling.some((r) => r.ruleId === 'no-restricted-syntax')).toBe(true)
  })
})
