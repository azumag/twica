# コードレビュ結果

**レビュー日:** 2026-01-17
**レビュー対象:** docs/ARCHITECTURE.md, docs/IMPLEMENTED.md, 実装コード

---

## 概要

前回レビューで発見された4つの問題（#1-#4）はすべて修正されています。
新たに1つの軽微な非効率性を発見しましたが、バグではありません。

---

## 前回レビュー問題の修正確認

### #1 RLSポリシーの重複定義 ✅ 修正済

**対象ファイル:** `supabase/migrations/00001_initial_schema.sql`

**確認結果:** 重複するポリシー定義はすべて削除・統合されています。

```
修正後（重複なし）:
- "Cards are viewable by everyone" ON cards (1回: line 112-113)
- "Active streamers are viewable by everyone" ON streamers (1回: line 115-117)
- "Service can insert gacha history" ON gacha_history (1回: line 138-140)
```

---

### #2 EventSubべき等性チェックの競合状態 ✅ 修正済

**対象ファイル:** `src/lib/services/gacha.ts:40-51`

**確認結果:** INSERTがupsertに変更され、`onConflict: 'event_id'` と `ignoreDuplicates: true` が使用されています。

```typescript
// 修正後（正しい実装）
await this.supabase
  .from('gacha_history')
  .upsert({
    event_id: eventId || null,
    user_twitch_id: userTwitchId,
    user_twitch_username: userTwitchUsername,
    card_id: selectedCard.id,
    streamer_id: streamerId,
  }, {
    onConflict: 'event_id',
    ignoreDuplicates: true,
  })
```

---

### #3 設計書のセッション有効期限を7日に更新 ✅ 修正済

**対象ファイル:** `docs/ARCHITECTURE.md:387`

**確認結果:** 設計書と実装が一致しています。

```
設計書（ARCHITECTURE.md:387）:
> カスタムCookieによるセッション管理（7日有効期限）

実装（callback/route.ts:72）:
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7日間
```

---

### #4 ファイルアップロードの検証を強化 ✅ 修正済

**対象ファイル:** `src/app/api/upload/route.ts:23-27, 56-58`

**確認結果:** MIMEタイプと拡張子の整合性を検証する `validateFileType` 関数が実装されています。

```typescript
// 実装済み
const TYPE_TO_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
};

function validateFileType(mimeType: string, ext: string): boolean {
  const allowedExts = TYPE_TO_EXTENSIONS[mimeType];
  if (!allowedExts) return false;
  return allowedExts.includes(ext);
}

// 使用
if (!validateFileType(file.type, ext)) {
  return NextResponse.json({ error: 'ファイル形式が一致しません' }, { status: 400 });
}
```

---

## 新たに発見された問題

### #1 べき等性チェックの重複実行（非効率性）

**対象ファイル:** `src/app/api/twitch/eventsub/route.ts:93-103`

**問題内容:**
EventSubハンドラで重複チェックが2回実行されています。

```typescript
// 1回目のチェック（eventsub/route.ts:93-103）
const { data: existingHistory } = await supabaseAdmin
  .from('gacha_history')
  .select('id')
  .eq('event_id', messageId)
  .single();

if (existingHistory) {
  return;  // 重複スキップ
}

// 2回目のチェック（gacha.ts:42-51 - upsertのonConflict）
await this.supabase
  .from('gacha_history')
  .upsert({...}, {
    onConflict: 'event_id',
    ignoreDuplicates: true,
  })
```

**影響:**
- データベースクエリが余分に1回実行される
- 軽微なパフォーマンス低下（约5-10ms）
- 機能的には正しい

**修正提案（オプション）:**
eventsub/route.ts の事前チェックを削除し、gacha.ts の upsert に完全依存することで効率化できます。ただし、現在の実装はバグではないため、修正は任意です。

```typescript
// 省略可能: eventsub/route.ts の事前SELECTを削除
// gacha.ts の upsert がべき等性を保証する
```

---

## 軽微な改善提案（オプション）

### Math.random() の使用

**対象ファイル:** `src/lib/gacha.ts:17`

**現状:**
```typescript
const random = Math.floor(Math.random() * totalWeightInt)
```

**評価:** 前回レビューでも指摘されましたが、ガチャシステムの文脈では許容範囲です。`Math.random()` は暗号学的に安全ではありませんが、ガチャの公平性への影響は限定的です。修正は任意です。

---

## コード品質の良好点

### ✅ アーキテクチャ・設計
- Next.js App Router + Server Components の適切な採用
- Supabase + Vercel Blob のマネージドサービス活用
- RLS による多層防御
- 設計書と実装の整合性確保

### ✅ セキュリティ
- Twitch OAuth + カスタムCookie セッション管理
- CSRF対策 (SameSite=Lax + state検証)
- Twitch署名検証（EventSub Webhook）
- ファイルアップロード検証（MIME + 拡張子整合性）
- 環境変数によるシークレット管理

### ✅ コード品質
- TypeScript の厳格モード活用
- Resultパターンの一貫した使用
- 適切なエラーハンドリング
- ログ出力の実装

### ✅ データベース設計
- 適切なインデックス設計
- UNIQUE制約によるべき等性保証
- 外部キー制約による参照整合性
- CHECK制約によるデータ検証

---

## テスト結果

| テストカテゴリ | 結果 |
|:---|:---:|
| ユニットテスト | 28件全てパス |
| Lint | パス |
| Type Check | パス |
| ビルド | 成功 |

---

## 判定

| 項目 | 判定 |
|:---|:---:|
| 前回レビュー問題の修正 | ✅ すべて修正済 |
| 新たな重大な問題 | なし |
| 新たな軽微な問題 | 1件（非効率性、修正は任意） |
| QAへの依頼 | ✅ 承認 |

---

## 次のアクション

実装エージェントへのフィードバックは**不要**です（すべての重大な問題が修正済）。

**QAエージェントへのQA依頼を実行してください。**

唯一の軽微な問題（べき等性チェックの重複実行）は機能に影響はなく、修正はオプションです。QA工程で他の重大な問題が発見されなければ、QA合格としてください。
