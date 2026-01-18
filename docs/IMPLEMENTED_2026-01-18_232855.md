# 実装内容

## Issue #41: Code Quality - Hardcoded Card Stat Generation Ranges in battle.ts

### 実装概要
`src/lib/battle.ts` の `generateCardStats` 関数にハードコードされていたカードステータス生成範囲を、定数として `src/lib/constants.ts` に移動しました。

### 変更内容

#### 1. `src/lib/constants.ts` に定数を追加

- `CARD_STAT_RANGES`: 各レアリティ（コモン、レア、エピック、レジェンダリー）のステータス生成範囲を定義
- `CARD_STAT_DEFAULTS`: デフォルト値を定義

```typescript
export const CARD_STAT_RANGES = {
  common: {
    hp: { min: 100, max: 120 },
    atk: { min: 20, max: 30 },
    def: { min: 10, max: 15 },
    spd: { min: 1, max: 3 },
    skill_power: { min: 5, max: 10 },
  },
  rare: {
    hp: { min: 120, max: 140 },
    atk: { min: 30, max: 40 },
    def: { min: 15, max: 20 },
    spd: { min: 3, max: 5 },
    skill_power: { min: 10, max: 15 },
  },
  epic: {
    hp: { min: 140, max: 160 },
    atk: { min: 40, max: 45 },
    def: { min: 20, max: 25 },
    spd: { min: 5, max: 7 },
    skill_power: { min: 15, max: 20 },
  },
  legendary: {
    hp: { min: 160, max: 200 },
    atk: { min: 45, max: 50 },
    def: { min: 25, max: 30 },
    spd: { min: 7, max: 10 },
    skill_power: { min: 20, max: 25 },
  },
} as const

export const CARD_STAT_DEFAULTS = {
  hp: 100,
  atk: 30,
  def: 15,
  spd: 5,
  skill_power: 10,
} as const
```

#### 2. `src/lib/battle.ts` で定数を使用

- `generateCardStats` 関数を定数を使用するように修正
- `CARD_STAT_RANGES` と `CARD_STAT_DEFAULTS` をインポートして使用

```typescript
import { CARD_STAT_RANGES, CARD_STAT_DEFAULTS } from '@/lib/constants'

export function generateCardStats(rarity: Rarity): {
  hp: number
  atk: number
  def: number
  spd: number
  skill_type: SkillType
  skill_name: string
  skill_power: number
} {
  const skillTypes: SkillType[] = ['attack', 'defense', 'heal', 'special']

  const statRanges = CARD_STAT_RANGES[rarity as keyof typeof CARD_STAT_RANGES]

  let hp: number, atk: number, def: number, spd: number, skill_power: number

  if (statRanges) {
    hp = Math.floor(Math.random() * (statRanges.hp.max - statRanges.hp.min + 1)) + statRanges.hp.min
    atk = Math.floor(Math.random() * (statRanges.atk.max - statRanges.atk.min + 1)) + statRanges.atk.min
    def = Math.floor(Math.random() * (statRanges.def.max - statRanges.def.min + 1)) + statRanges.def.min
    spd = Math.floor(Math.random() * (statRanges.spd.max - statRanges.spd.min + 1)) + statRanges.spd.min
    skill_power = Math.floor(Math.random() * (statRanges.skill_power.max - statRanges.skill_power.min + 1)) + statRanges.skill_power.min
  } else {
    hp = CARD_STAT_DEFAULTS.hp
    atk = CARD_STAT_DEFAULTS.atk
    def = CARD_STAT_DEFAULTS.def
    spd = CARD_STAT_DEFAULTS.spd
    skill_power = CARD_STAT_DEFAULTS.skill_power
  }

  const skill_type = skillTypes[Math.floor(Math.random() * skillTypes.length)]
  const skillNameList = BATTLE_SKILL_NAMES[skill_type.toUpperCase() as keyof typeof BATTLE_SKILL_NAMES]
  const skill_name = skillNameList[Math.floor(Math.random() * skillNameList.length)]

  return {
    hp,
    atk,
    def,
    spd,
    skill_type,
    skill_name,
    skill_power
  }
}
```

### 受け入れ基準

- [x] `CARD_STAT_RANGES` 定数が `src/lib/constants.ts` に追加されている
- [x] `src/lib/battle.ts` で `CARD_STAT_RANGES` 定数が使用されている
- [x] `generateCardStats` 関数が定数を使用して実装されている
- [x] コモン、レア、エピック、レジェンダリーの各レアリティで正しい範囲でステータスが生成される
- [x] デフォルト値が正しく設定されている
- [x] 既存のカード生成ロジックの挙動が変わらない（テストがパスする）
- [x] lintとtestがパスする
- [x] TypeScriptの型チェックがパスする

### テスト結果

- Lint: パス
- Test: 59 テスト全てパス
  - tests/unit/constants.test.ts (6 tests)
  - tests/unit/gacha.test.ts (6 tests)
  - tests/unit/logger.test.ts (6 tests)
  - tests/unit/env-validation.test.ts (10 tests)
  - tests/unit/battle.test.ts (24 tests)
  - tests/unit/upload.test.ts (7 tests)

### メリット

1. **保守性向上**: ゲームバランスの調整が定数の変更のみで可能
2. **可読性向上**: コードの意図が明確になる
3. **一貫性**: 設計原則「String Standardization」「Constant Standardization」に準拠

### 詳細設計

詳細な設計内容は `docs/ARCHITECTURE.md` の Issue #41 セクションを参照してください。
