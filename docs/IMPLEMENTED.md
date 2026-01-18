# 実装完了レポート: Battle System Constants Refactoring (Issue #37)

**日時**: 2026-01-18 22:48

---

## 概要

バトルシステムの設定値が `src/lib/battle.ts` にハードコードされている問題を解決しました。設定値を `BATTLE_CONFIG` 定数として `src/lib/constants.ts` に一元管理し、保守性とバランス調整の容易性を向上させました。

---

## 実装内容

### 1. BATTLE_CONFIG 定数の追加

**ファイル**: `src/lib/constants.ts`

バトルシステムの設定値を定数として追加しました。

```typescript
export const BATTLE_CONFIG = {
  MAX_TURNS: 20,
  SKILL_SPEED_MULTIPLIER: 10,
  SKILL_TRIGGER_MAX_PERCENT: 70,
  RANDOM_RANGE: 100,
  SPECIAL_SKILL_DAMAGE_MULTIPLIER: 1.5,
} as const
```

**設定値の説明**:
- `MAX_TURNS`: 最大ターン数（20ターン）
- `SKILL_SPEED_MULTIPLIER`: スキル発動率計算の速度倍率（SPD × 10）
- `SKILL_TRIGGER_MAX_PERCENT`: スキル発動率の上限（70%）
- `RANDOM_RANGE`: ランダム判定の範囲（100%）
- `SPECIAL_SKILL_DAMAGE_MULTIPLIER`: スペシャルスキルのダメージ倍率（1.5倍）

---

### 2. battle.ts での定数使用

**ファイル**: `src/lib/battle.ts`

ハードコードされた値を `BATTLE_CONFIG` 定数で置換しました。

#### 2.1 定数のインポート

```typescript
import { CPU_CARD_STRINGS, BATTLE_SKILL_NAMES, BATTLE_LOG_MESSAGES, BATTLE_CONFIG } from '@/lib/constants'
```

#### 2.2 最大ターン数の置換

```typescript
// 修正前
export async function playBattle(userCard: BattleCard, opponentCard: BattleCard): Promise<BattleResultData> {
  const maxTurns = 20
  // ...

// 修正後
export async function playBattle(userCard: BattleCard, opponentCard: BattleCard): Promise<BattleResultData> {
  const maxTurns = BATTLE_CONFIG.MAX_TURNS
  // ...
```

#### 2.3 スキル発動率計算の置換

```typescript
// 修正前
// Skill trigger chance (SPD * 10%, max 70%)
const skillTriggerChance = Math.min(attacker.spd * 10, 70)
const skillTrigger = Math.random() * 100 < skillTriggerChance

// 修正後
const skillTriggerChance = Math.min(
  attacker.spd * BATTLE_CONFIG.SKILL_SPEED_MULTIPLIER,
  BATTLE_CONFIG.SKILL_TRIGGER_MAX_PERCENT
)
const skillTrigger = Math.random() * BATTLE_CONFIG.RANDOM_RANGE < skillTriggerChance
```

#### 2.4 スペシャルスキルダメージ倍率の置換

```typescript
// 修正前
case 'special':
  // Special effects can be implemented later
  const specialDamage = Math.max(1, Math.floor(attacker.atk * 1.5) - defender.def)
  return {
    damage: specialDamage,
    message: BATTLE_LOG_MESSAGES.SKILL_SPECIAL(attacker.name, attacker.skill_name, specialDamage)
  }

// 修正後
case 'special':
  const specialDamage = Math.max(1, Math.floor(attacker.atk * BATTLE_CONFIG.SPECIAL_SKILL_DAMAGE_MULTIPLIER) - defender.def)
  return {
    damage: specialDamage,
    message: BATTLE_LOG_MESSAGES.SKILL_SPECIAL(attacker.name, attacker.skill_name, specialDamage)
  }
```

---

## 変更ファイル一覧

### 修正
- `src/lib/constants.ts` - BATTLE_CONFIG 定数を追加
- `src/lib/battle.ts` - ハードコードされた値を定数で置換

---

## 設計方針との整合性

| 設計方針 | 遵守状況 | 詳細 |
|---------|---------|------|
| String Standardization | ✅ 遵守 | バトル設定値を定数として一元管理 |
| Simple over Complex | ✅ 遵守 | シンプルな定数定義を使用 |
| Maintainability | ✅ 向上 | バランス調整が容易になった |

---

## 受け入れ基準の達成状況

| 受け入れ基準 | 達成状況 | 詳細 |
|-------------|----------|------|
| BATTLE_CONFIG 定数が追加されている | ✅ 達成 | src/lib/constants.ts に定義済み |
| BATTLE_CONFIG 定数が使用されている | ✅ 達成 | src/lib/battle.ts で使用 |
| maxTurns が置換されている | ✅ 達成 | BATTLE_CONFIG.MAX_TURNS を使用 |
| スキル発動率計算で定数を使用 | ✅ 達成 | SKILL_SPEED_MULTIPLIER と SKILL_TRIGGER_MAX_PERCENT を使用 |
| ランダム範囲で定数を使用 | ✅ 達成 | BATTLE_CONFIG.RANDOM_RANGE を使用 |
| スペシャルスキルダメージ倍率で定数を使用 | ✅ 達成 | SPECIAL_SKILL_DAMAGE_MULTIPLIER を使用 |
| 既存のバトルシステムの挙動が変わらない | ✅ 達成 | 定数の値は元のハードコード値と同じ |
| lint がパスする | ✅ 達成 | npm run lint が成功 |
| TypeScript の型チェックがパスする | ✅ 達成 | tsc --noEmit が成功 |

---

## テスト

### Lint
```bash
npm run lint
```
結果: ✅ パス

### TypeScript Type Check
```bash
npx tsc --noEmit
```
結果: ✅ パス

---

## メリット

1. **保守性の向上**: バトルシステムのバランス調整を行う際、定数ファイルを変更するだけで済む
2. **一元管理**: すべてのバトル設定値が一箇所で管理される
3. **可読性の向上**: 定数名で設定値の意味が明確になる
4. **テストの容易さ**: 定数を変更して挙動を確認しやすい

---

## 関連Issue

- **Issue #37**: Code Quality - Hardcoded Battle Configuration Values in battle.ts

---

## まとめ

バトルシステムのハードコードされた設定値を定数として抽出し、保守性を向上させました。すべての受け入れ基準を満たし、lint と TypeScript 型チェックをパスしました。今後のバランス調整が容易になりました。
