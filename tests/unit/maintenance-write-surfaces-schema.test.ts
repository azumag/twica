import { describe, it, expect } from 'vitest'
import surfaces from '../../config/maintenance-write-surfaces.json'
import { validateSchema } from '../../scripts/check-maintenance-surfaces.js'

/**
 * config/maintenance-write-surfaces.json のスキーマ検証 (#694 Stage 3 / Stage 5)。
 *
 * このJSONは src/middleware.ts に静的importされ、allowlist判定
 * （src/lib/maintenance/allowlist.ts）に使われる。実行時に壊れた形の
 * エントリが紛れ込むと「allowlist登録し忘れ=安全側にブロック」という
 * fail-safe設計が壊れかねない（例: maintenanceBehaviorのtypoで
 * 'allow' のつもりが免除されない、pathのtypoで意図しないルートを
 * 免除してしまう等）ため、CIで機械的に検証する。
 *
 * スキーマ検査ルールそのものは scripts/check-maintenance-surfaces.js の
 * validateSchema() を単一の実装元 (single source of truth) とする
 * (#694 Stage 5, Fableレビュー指摘2: 以前はこのファイルにルールを個別に
 * 再実装しており、CLIスクリプト側の同等ロジックとdrift/漏れのリスクが
 * あった。実際にreviewedAtのDate.parse可能性・redirectのmethods制約・
 * blockのGET非含有の3ルールがCLIスクリプト側から欠落していた)。
 * このファイルは実configに対して validateSchema() が空配列を返すことだけを
 * 確認する薄いラッパーであり、ルール単位のfixtureテスト (各違反パターン) は
 * tests/unit/check-maintenance-surfaces.test.ts の describe('validateSchema')
 * に集約されている。
 */
describe('config/maintenance-write-surfaces.json スキーマ', () => {
  it('validateSchema() が空配列を返す (= 検査ルールを全て満たす)', () => {
    expect(validateSchema(surfaces)).toEqual([])
  })
})
