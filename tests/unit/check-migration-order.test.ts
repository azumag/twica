import { describe, expect, it } from 'vitest'
import {
  extractMigrationNumber,
  validateMigrationOrder,
  validateNewMigrationsAreHighest,
  parseNameStatus,
  excludeSameNumberRenames,
} from '../../scripts/check-migration-order.js'

describe('extractMigrationNumber', () => {
  it('抽出した番号と生の桁文字列を返す', () => {
    expect(extractMigrationNumber('00042_add_foo.sql')).toEqual({ raw: '00042', value: 42 })
  })

  it('数値プレフィックスのないファイル名は null を返す', () => {
    expect(extractMigrationNumber('add_foo.sql')).toBeNull()
    expect(extractMigrationNumber('README.md')).toBeNull()
    expect(extractMigrationNumber('seed.sql')).toBeNull()
  })
})

describe('validateMigrationOrder', () => {
  it('ファイル名順に番号が重複なく増加していれば valid', () => {
    const result = validateMigrationOrder(['00001_init.sql', '00002_add_users.sql', '00010_add_cards.sql'])

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('欠番 (削除・リナンバーによるギャップ) は許容する', () => {
    const result = validateMigrationOrder(['00001_init.sql', '00005_add_users.sql', '00099_add_cards.sql'])

    expect(result.valid).toBe(true)
  })

  it('入力の順序に関わらずファイル名でソートしてから検証する', () => {
    // わざと逆順で渡しても、ファイル名昇順に並べ直した上で判定される
    const result = validateMigrationOrder(['00010_add_cards.sql', '00001_init.sql', '00002_add_users.sql'])

    expect(result.valid).toBe(true)
  })

  it('桁数の異なるプレフィックスが混在すると文字列順と数値順がズレて検出される', () => {
    // '00010_y.sql' は文字列比較で '9_x.sql' より前に来るが、数値としては 10 > 9 なので
    // ファイル名順に並べると番号が逆順 (10 の次に 9) になる、実際に起こりうる採番ミスの再現
    const result = validateMigrationOrder(['9_x.sql', '00010_y.sql'])

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('逆順'))).toBe(true)
  })

  it('同じ番号を持つファイルが複数あると重複として検出される', () => {
    const result = validateMigrationOrder(['00005_a.sql', '00005_b.sql', '00006_c.sql'])

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('重複'))).toBe(true)
  })

  it('番号が減少するリグレッション (#525-527 相当) を検出する', () => {
    // ファイル名昇順で 00059 の次に 00060 が来るのは正常だが、
    // ここでは 00060 の次に 00059 が並ぶ壊れたケースを直接構築して検証する
    const result = validateMigrationOrder(['00060_fast_pr.sql', '00061_late_pr_wrong.sql'])
    expect(result.valid).toBe(true) // これは正常系 (増加している)

    const broken = validateMigrationOrder(['0059_late_pr.sql', '00060_fast_pr.sql'])
    // '0059...' (4桁) は文字列比較で '00060...' (5桁) より後ろに来るため、
    // 抽出番号は [60, 59] となり逆順として検出される
    expect(broken.valid).toBe(false)
  })

  it('数値プレフィックスのないファイルはエラーとして報告する', () => {
    const result = validateMigrationOrder(['00001_init.sql', 'not_numbered.sql'])

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('not_numbered.sql'))).toBe(true)
  })
})

describe('validateNewMigrationsAreHighest', () => {
  it('新規ファイルの番号が既存の最大番号より大きければ valid', () => {
    const result = validateNewMigrationsAreHighest(
      ['00058_a.sql', '00059_b.sql', '00060_c.sql'],
      ['00061_new.sql', '00062_new2.sql']
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('#525-527 の再現: 先にマージされた PR が確保した番号より小さい番号で新規追加すると invalid', () => {
    // ベースブランチには既に 00060 まで存在する (別の速い PR が先にマージ・適用済み)
    // このブランチは着手が早かったため 00059 を採番していたが、マージが遅れた
    const result = validateNewMigrationsAreHighest(['00058_a.sql', '00059_b.sql', '00060_faster_pr.sql'], [
      '00059_this_pr.sql',
    ])

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('00059_this_pr.sql')
  })

  it('新規ファイルの番号が既存の最大番号と同じ (重複)場合も invalid', () => {
    const result = validateNewMigrationsAreHighest(['00060_a.sql'], ['00060_b.sql'])

    expect(result.valid).toBe(false)
  })

  it('既存ファイルが空でも新規ファイルが妥当な番号なら valid', () => {
    const result = validateNewMigrationsAreHighest([], ['00001_init.sql'])

    expect(result.valid).toBe(true)
  })

  it('新規ファイルが空なら常に valid', () => {
    const result = validateNewMigrationsAreHighest(['00060_a.sql'], [])

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('parseNameStatus', () => {
  it('A/D ステータス行を added/deleted に振り分ける', () => {
    const output = ['A\tsupabase/migrations/00061_new.sql', 'D\tsupabase/migrations/00050_old.sql'].join('\n')

    expect(parseNameStatus(output)).toEqual({
      added: ['00061_new.sql'],
      deleted: ['00050_old.sql'],
    })
  })

  it('.sql 以外のファイルは無視する', () => {
    const output = ['A\tREADME.md', 'A\tsupabase/migrations/00061_new.sql'].join('\n')

    expect(parseNameStatus(output)).toEqual({
      added: ['00061_new.sql'],
      deleted: [],
    })
  })

  it('空文字列や空行のみの入力では空配列を返す', () => {
    expect(parseNameStatus('')).toEqual({ added: [], deleted: [] })
    expect(parseNameStatus('\n\n')).toEqual({ added: [], deleted: [] })
  })

  it('M (変更) など A/D 以外のステータスは無視する', () => {
    const output = 'M\tsupabase/migrations/00061_new.sql'

    expect(parseNameStatus(output)).toEqual({ added: [], deleted: [] })
  })
})

describe('excludeSameNumberRenames', () => {
  it('同じ番号が削除側にもある「その場リネーム」は新規追加から除外する', () => {
    // 00002_add_users.sql の誤字を直しただけで番号は変えていないケース
    const result = excludeSameNumberRenames(['00002_add_users_fixed_typo.sql'], ['00002_add_users.sql'])

    expect(result).toEqual([])
  })

  it('番号自体が変わるリナンバーは除外されず引き続き検証対象になる', () => {
    // 00050 を 00070 にリナンバーした場合、追加側と削除側で番号が異なるため除外しない
    const result = excludeSameNumberRenames(['00070_renumbered.sql'], ['00050_renumbered.sql'])

    expect(result).toEqual(['00070_renumbered.sql'])
  })

  it('削除ファイルがなければ全ての追加ファイルをそのまま返す', () => {
    const result = excludeSameNumberRenames(['00061_new.sql', '00062_new2.sql'], [])

    expect(result).toEqual(['00061_new.sql', '00062_new2.sql'])
  })

  it('不正なファイル名の追加ファイルは除外せず後続チェックに回す', () => {
    const result = excludeSameNumberRenames(['not_numbered.sql'], ['00002_old.sql'])

    expect(result).toEqual(['not_numbered.sql'])
  })
})

describe('統合シナリオ: リネームを検出してからルール2を適用する', () => {
  it('その場リネームのみの PR は常に valid になる', () => {
    const diffOutput = [
      'A\tsupabase/migrations/00002_add_users_fixed_typo.sql',
      'D\tsupabase/migrations/00002_add_users.sql',
    ].join('\n')
    const { added, deleted } = parseNameStatus(diffOutput)
    const newFilenames = excludeSameNumberRenames(added, deleted)

    const result = validateNewMigrationsAreHighest(
      ['00001_init.sql', '00002_add_users.sql', '00068_latest.sql'],
      newFilenames
    )

    expect(result.valid).toBe(true)
  })
})
