# 実装記録

## 日付

2026-01-17

## レビュー対応修正（11回目）

### 修正履歴

以下のレビュー問題を修正しました。

---

### 1. #1 RLSポリシーの重複定義を削除

**対象ファイル:** `supabase/migrations/00001_initial_schema.sql`

**問題:**
RLSポリシーが複数回重複して定義されていました。

**重複していたポリシー:**
- "Active streamers are viewable by everyone" ON streamers (2回)
- "Service can insert gacha history" ON gacha_history (2回)

**修正内容:**
重複しているポリシー定義を削除し、一箇所に統合しました。

```sql
-- 修正前: 同じポリシーが複数回定義
CREATE POLICY "Active streamers are viewable by everyone" ON streamers ...; -- 1回目
CREATE POLICY "Active streamers are viewable by everyone" ON streamers ...; -- 2回目（重複）

-- 修正後: 1回に統合
CREATE POLICY "Active streamers are viewable by everyone" ON streamers
  FOR SELECT USING (is_active = true);
```

---

### 2. #2 EventSubべき等性チェックのアトミック性を確保

**対象ファイル:** `src/lib/services/gacha.ts`

**問題:**
べき等性チェックとINSERTがアトミックではなかったため、同時に複数の同じEventSubメッセージが届いた場合、一意制約違反エラーになる可能性がありました。

**修正内容:**
INSERTをupsertに変更し、`onConflict: 'event_id'` と `ignoreDuplicates: true` を使用しました。

```typescript
// 修正前
await this.supabase
  .from('gacha_history')
  .insert({...})

// 修正後
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

**効果:**
- 競合状態が発生しても一意制約違反エラーにならない
- 同じevent_idの場合は自動的にスキップされる

---

### 3. #3 設計書のセッション有効期限を7日に更新

**対象ファイル:** `docs/ARCHITECTURE.md`

**問題:**
設計書では「30日」と記載されていましたが、実装では7日になっていました。

**修正内容:**

```markdown
変更前:
- カスタムCookieによるセッション管理（30日有効期限）

変更後:
- カスタムCookieによるセッション管理（7日有効期限）
```

**セキュリティ上の理由:**
- 7日の方がセキュリティリスクが低い
- 実装と設計書の整合性を確保

---

### 4. #4 ファイルアップロードの検証を強化

**対象ファイル:** `src/app/api/upload/route.ts`

**問題:**
ファイル拡張子の検証のみで、MIMEタイプと拡張子の整合性を確認していませんでした。

**修正内容:**
MIMEタイプと拡張子の整合性を検証する関数を追加しました。

```typescript
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

// 使用例
if (!validateFileType(file.type, ext)) {
  return NextResponse.json({ error: 'ファイル形式が一致しません' }, { status: 400 });
}
```

**効果:**
- 拡張子とMIMEタイプの整合性を確認
- 攻撃者が拡張子を偽装したファイルをアップロードするリスクを軽減

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|:---|:---|
| `supabase/migrations/00001_initial_schema.sql` | 重複RLSポリシーを削除・統合 |
| `src/lib/services/gacha.ts` | INSERTをupsertに変更（一意制約違反を防止） |
| `src/app/api/upload/route.ts` | MIMEタイプと拡張子の整合性検証を追加 |
| `docs/ARCHITECTURE.md` | セッション有効期限を7日に更新、更新履歴に追加 |

## テスト結果

| テストカテゴリ | 結果 |
|:---|:---:|
| ユニットテスト | 28件全てパス |
| Lint | パス |
| Type Check | パス |
| ビルド | 成功 |

## 影響範囲

| 項目 | 影響 |
|:---|:---|
| RLSポリシー | 重複を削除し、整理完了 |
| EventSubべき等性 | アトミック性を確保 |
| セッション管理 | 設計書と実装の整合性を確保 |
| ファイルアップロード | セキュリティ強化（MIME検証追加） |
