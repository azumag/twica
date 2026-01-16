# リファクタリング・コードレビュー結果

**レビューコミット**: `64f658a` (refactor: implement refactoring and fix E2E tests)
**レビュー日**: 2026-01-16
**レビュアー**: opencode

---

## 評価サマリー

| 項目 | 評価 | 備考 |
|------|------|------|
| Supabaseクライアント整理 | ✅ 完了 | export名が適切に別名化 |
| Gachaアルゴリズム抽出 | ✅ 完了 | `lib/gacha.ts` に分離 |
| 定数ファイル作成 | ✅ 完了 | `lib/constants.ts` |
| 環境変数検証 | ✅ 完了 | `env-validation.ts` |
| セキュリティ修正 | ✅ 完了 | XSS脆弱性修正 |
| Dashboard分割 | ❌ 未完了 | 399行のまま |
| GachaService作成 | ❌ 未完了 | ビジネスロジックが分散 |
| SSE外部化 | ❌ 未完了 | In-memory Map継続 |
| Result型導入 | ❌ 未完了 | エラー処理は不統一 |
| console.log除去 | ❌ 未完了 | 39箇所に残存 |

---

## 重大な問題 (Critical Issues)

### 1. ビジネスロジックの重複 ⚠️

**ファイル**: `src/app/api/gacha/route.ts:19-76` と `src/app/api/twitch/eventsub/route.ts:140-197`

```typescript
// gacha/route.ts
const { data: user } = await supabaseAdmin
  .from("users")
  .select("id")
  .eq("twitch_user_id", userTwitchId)
  .single();

// eventsub/route.ts (重複)
const { data: user } = await supabaseAdmin
  .from("users")
  .select("id")
  .eq("twitch_user_id", event.user_id)
  .single();
```

**問題点**: 
- ユーザー存在チェック+カード付与+gacha履歴記録が2箇所に重複
- いずれか一方の修正がもう一方に反映されないリスク
- 設計書で予定されていた`GachaService`が未実装

**修正案**:
```typescript
// src/lib/services/gacha/service.ts (未作成)
export class GachaService {
  async execute(userTwitchId: string, streamerId: string): Promise<Result<Card, Error>> {
    // 重複ロジックを一箇所に集約
  }
}
```

---

### 2. SSE接続管理のServerless非対応 ⚠️

**ファイル**: `src/app/api/twitch/eventsub/route.ts:13`

```typescript
const sseConnections = new Map<string, Set<ReadableStreamDefaultController>>();
```

**問題点**:
- 設計書で指摘された通り、in-memory Map使用
- Vercel/Cloudflare等のserverless環境で接続が消失
- 複数の实例が個別にSSE接続を保持し、一貫性がない

**影響範囲**:
- `addSSEConnection()` / `removeSSEConnection()` / `notifySSEClients()` 全関数

**修正案**: KVストア（Upstash Redis/Vercel KV）への移行が必要

---

### 3. Dashboardページの肥大化 ⚠️

**ファイル**: `src/app/dashboard/page.tsx` (399行)

**問題点**:
- 設計書で「150行以下」とされていたが、399行のまま
- 単一責任の原則違反
- 保守性・テスト容易性が低い

**未分割のコンポーネント**:
- `DashboardHeader` - ヘッダーUI
- `StreamerSection` - 配信者設定セクション
- `CollectionStats` - コレクション統計
- `GachaHistorySection` - 最近獲得情報
- `CollectionGrid` - カードグリッド

---

## セキュリティレビュー

### ✅ 対応済み

1. **XSS脆弱性修正** (`callback/route.ts:95`)
   - `encodeURIComponent`追加で解決

2. **セッション有効期限検証** (`session.ts:26-28`)
   ```typescript
   if (session.expiresAt && Date.now() > session.expiresAt) {
     return null
   }
   ```

### ⚠️ 残存リスク

1. **デバッグログに機密情報露出可能性**
   - `eventsub/route.ts:99`: `console.log("EventSub notification:", subscriptionType, event)`
   - `eventsub/route.ts:208`: カード名・ユーザー名が平文ログ出力

2. **エラーハンドリングの不備**
   ```typescript
   // eventsub/route.ts:209-210
   } catch (error) {
     console.error("Error handling redemption:", error);
   }
   ```
   - エラーが握りつぶされ、詳細がクライアントに伝わらない
   - エラー型の定義がない

---

## パフォーマンスレビュー

### ⚠️ N+1クエリ問題

**ファイル**: `src/app/dashboard/page.tsx:50-79`

```typescript
const { data: userCards } = await supabaseAdmin
  .from("user_cards")
  .select(`
    card_id,
    cards (*, streamers (*))
  `)
  .eq("user_id", user.id);

// 手動での集約処理（DBで処理すべき）
const cardMap = new Map<string, CardWithDetails>();
for (const uc of userCards) {
  // 手動でカウント計算...
}
```

**修正案**: `count()` aggregateとGROUP BYを使用

---

### ⚠️ 最適化機会

1. **selectWeightedCard** (`lib/gacha.ts:6-21`)
   - 呼び出すたびに`reduce()`でtotalWeightを再計算
   - カードリストが変化しない場合、事前計算可能

2. **Dashboardページ**
   - 3つの非同期関数を並列実行していない
   ```typescript
   // 現状: 順次実行
   const streamerData = isStreamer ? await getStreamerData(session.twitchUserId) : null;
   const userCards = await getUserCards(session.twitchUserId);
   const recentGacha = await getRecentGachaHistory();
   ```

---

## コード品質レビュー

### 1. console.log/console.error の残存 (39箇所)

**主要な残存箇所**:
- `eventsub/route.ts`: 11件
- `twitch/rewards/route.ts`: 6件
- `twitch/eventsub/subscribe/route.ts`: 5件

**設計書の指示**: loggerへの置換または削除

---

### 2. 定数使用の不統一

**ハードコードされた値**:
```typescript
// eventsub/route.ts:8-10
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";
```

→ `lib/constants.ts` に統合すべき

---

### 3. 型安全性の課題

**issues**:
```typescript
// session.ts:31
} catch (error) {  // errorがunknown型
// eventsub/route.ts:112-117
async function handleRedemption(event: {  // インライン型定義
  broadcaster_user_id: string;
  ...
})
```

**修正案**: 
- 専用の`TwitchEvent`型を定義
- Result型を導入

---

## テストカバレッジ

### ✅ 改善済み

- E2Eテストの修正（URL、フォーム名、固有カード名）

### ❌ 不足

- `lib/gacha.ts` のユニットテストなし
- `lib/env-validation.ts` のユニットテストなし
- `lib/constants.ts` のユニットテストなし
- APIエラーハンドリングの統合テストなし

---

## 後方互換性

### ✅ 維持

- APIインターフェース変更なし
- DBスキーマ変更なし

---

## 推奨アクション

### 即座に修正すべき (P0)

1. **GachaServiceの作成** - 重複コードの解消
2. **SSE接続のKVストア移行** - Serverless対応
3. **Dashboardのコンポーネント分割**

### 短期的に修正すべき (P1)

1. console.logのlogger置換
2. 定数の統合
3. Result型の導入
4. 型定義の整理

### 中期的に修正すべき (P2)

1. N+1クエリの最適化
2. selectWeightedCardのキャッシュ
3. ユニットテストの追加
4. エラーハンドリングの統一

---

## 合計問題数

| 重大度 | 数 |
|--------|-----|
| Critical | 3 |
| Major | 5 |
| Minor | 8 |

---

**レビュー完了日時**: 2026-01-16
**レビュー通過**: ❌ 要修正后再レビュー
