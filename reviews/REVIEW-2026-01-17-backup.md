# コードレビュー報告書

**レビュー実施日:** 2026-01-17
**レビュー対象:** docs/ARCHITECTURE.md, docs/IMPLEMENTED.md
**レビュー者:** レビューエージェント

---

## 概要

設計書と実装記録を厳しくレビューした結果、**重大な設計上の問題が発見されました**。特にデータベース設計に構造的な不整合があり、実装を進める前に修正が必要です。

---

## 重大な問題 (Critical Issues)

### 1. GACHA_HISTORY テーブルのリレーション設計の欠陥

**重要度:** 致命的 (Critical)

**問題:**
`GACHA_HISTORY` テーブルが `USERS` テーブルと正しくリレーションされていない。

```sql
GACHA_HISTORY {
    TEXT user_twitch_id      -- 問題: TEXT型、USERSテーブルへのFKではない
    TEXT user_twitch_username
    UUID card_id FK
    UUID streamer_id FK
}
```

**設計書との不整合:**
- 設計書には「視聴者は自分のカードとガチャ履歴のみ閲覧可能」と明記されている
- しかしながら、`GACHA_HISTORY` は `user_twitch_id` (TEXT) を使用しており、`USERS.id` (UUID) を参照していない
- `USER_CARDS` は正しく `UUID user_id FK` を使用しているのに対し、`GACHA_HISTORY` だけがこの規則から外れている

**影響:**
1. **参照整合性の欠如**: `user_twitch_id` が実際に存在するユーザーに紐づく保証がない
2. **RLSポリシーの困難**: 「視聴者は自分の履歴のみ閲覧」という制御が正しく実装できない
3. **データ整合性の問題**: ユーザーが削除された場合、履歴データの整合性を維持できない
4. **クエリ効率の低下**: TEXT型でのJOINはUUIDより遅い

**推奨修正案:**
```sql
GACHA_HISTORY {
    UUID id PK
    UUID user_id FK          -- USERS.id を参照
    UUID card_id FK
    UUID streamer_id FK
    TIMESTAMPTZ redeemed_at
}
-- user_twitch_id, user_twitch_username はキャッシュとして保持してもよいが、
-- 主たるリレーションは user_id とする
```

---

## 中程度の問題 (Medium Issues)

### 2. drop_rate の DECIMAL 精度の未定義

**重要度:** 中 (Medium)

**問題:**
```sql
CARDS {
    DECIMAL drop_rate        -- 精度とスケールが未定義
}
```

**影響:**
1. プラットフォームによって異なる精度で解釈される可能性がある
2. 確率的計算での丸め誤差
3. ドロップ率の合計検証 (`1.0以下`) の精度問題

**推奨修正案:**
```sql
DECIMAL(5, 4)  -- 0.0000 ~ 0.9999 まで4桁の精度
-- または NUMERIC(6, 5) でより高い精度
```

---

## 軽微な問題 (Minor Issues)

### 3. 設計書と実装記録の不整合

**docs/IMPLEMENTED.md について:**
- CI/CDにテスト実行ステップが追加されたことは適切
- しかし、テスト結果报告显示28件のユニットテストがパスしているが、これらのテストが設計書の要件をカバーしているか確認が必要

**確認すべき点:**
- 「受け入れ基準」の各項目に対応するテストが存在するか
- 特にRLSポリシーのテスト是否存在

---

## 設計原則との照合

| 原則 | 遵守状況 | 備考 |
|:---|:---:|:---|
| Simple over Complex | ⚠️ 部分的に遵守 | GACHA_HISTORYのリレーション設計が複雑化を招く |
| Type Safety | ⚠️ 警告 | drop_rateの型精度が未定義 |
| Separation of Concerns | ❌ 未遵守 | ユーザー履歴とカード履歴が別テーブルで管理されるべき |
| Security First | ⚠️ RLS実装困難 | user_twitch_id TEXTではRLSポリシーが複雑化 |

---

## セキュリティ上の考慮事項

### 懸念事項

1. **EventSub Webhook認証**: 設計書にはWebhooksの検証方法 (`challenge` パラメータの処理) が明記されていない
2. **セッション管理**: 30日の有効期間は適切だが、Refresh Tokenのローテーション戦略が必要か確認推奨

---

## 推奨アクション

### 実装エージェントへのフィードバック (必須)

1. **GACHA_HISTORY テーブルの再設計**
   - `user_twitch_id` を `user_id` (UUID FK to USERS.id) に変更
   - `user_twitch_id` と `user_twitch_username` は参照用のカラムとして別途保持することは可能

2. **drop_rate の型定義を修正**
   - `DECIMAL(5, 4)` または同等の精度を定義

3. **EventSub Webhookの認証ロジックを確認**
   - TwitchからのWebhooksが真正であることを検証する実装があるか確認

### 追加で確認すべき事項

- 28件のユニットテストのカバレッジ範囲
- RLSポリシーの実装計画
- テスト環境での確率計算の精度検証

---

## 結論

**QA依頼は行わないでください。**

設計書に重大なデータベース設計の問題があり、このまま実装を進めると以下のリスクがあります:
- データ整合性の問題
- セキュリティ (RLS) の脆弱性
- 将来的な拡張性の低下

**修正依頼:** 上記の問題を修正した後、再レビューを依頼してください。
