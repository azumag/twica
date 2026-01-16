# 実装記録

## 日付

2026-01-17

## APIルートのレート制限実装（Issue #13対応）

### 概要

docs/ARCHITECTURE.md に基づき、APIルートのレート制限を実装しました。これにより、DoS攻撃やAPI乱用を防止し、システムの安定性を向上させます。

### 実装内容

#### 1. レート制限ライブラリの確認

**依存関係**: `@upstash/ratelimit` と `@upstash/redis` は既にインストール済み

- `package.json` に `@upstash/ratelimit: ^2.0.8` と `@upstash/redis: ^1.36.1` が含まれていることを確認

#### 2. レート制限ライブラリの実装

**src/lib/rate-limit.ts** - 既存の実装を確認し、必要なレート制限設定が含まれていることを確認

- Redisとインメモリの両方に対応
- 各APIルートに適切なレート制限が設定済み
- IPアドレスとユーザーIDの両方を識別子として使用

#### 3. 各APIルートのレート制限確認

既存のすべてのAPIルートにレート制限が実装されていることを確認：

**✅ /api/upload/route.ts**
- 10リクエスト/1分の制限
- 429エラーと適切なヘッダーを返却

**✅ /api/cards/route.ts**
- POST: 20リクエスト/1分
- GET: 100リクエスト/1分
- 429エラーと適切なヘッダーを返却

**✅ /api/streamer/settings/route.ts**
- 10リクエスト/1分の制限
- 429エラーと適切なヘッダーを返却

**✅ /api/gacha/route.ts**
- 30リクエスト/1分の制限
- 429エラーと適切なヘッダーを返却

**✅ /api/auth/twitch/login/route.ts**
- 5リクエスト/1分の制限（IPベース）
- 429エラーを返却

**✅ /api/auth/twitch/callback/route.ts**
- 10リクエスト/1分の制限（IPベース）
- 429エラーをリダイレクトで返却

**✅ /api/auth/logout/route.ts**
- 10リクエスト/1分の制限
- 429エラーを返却

**✅ /api/twitch/eventsub/route.ts**
- 通知タイプ以外で1000リクエスト/1分の制限
- EventSub WebhookはTwitchからの信頼できる通知のため緩い設定

#### 4. グローバルレート制限ミドルウェア

**src/middleware.ts** - 更新済み

- すべてのAPIルートにグローバルレート制限を適用
- IPベースの識別子を使用
- EventSub用の緩い制限（1000リクエスト/1分）を適用

#### 5. フロントエンドでの429エラーハンドリング

**✅ src/components/CardManager.tsx** - 既存実装を確認
- アップロードAPI: 429エラーを適切に処理
- カードAPI: 429エラーを適切に処理
- 削除API: 429エラーを適切に処理

**✅ src/components/ChannelPointSettings.tsx** - 新規実装
- 報酬取得API: 429エラーを追加
- 報酬作成API: 429エラーを追加
- 設定保存API: 429エラーを追加
- EventSub登録API: 429エラーを追加

**✅ src/components/GachaHistorySection.tsx** - 新規実装
- 履歴削除API: 429エラーを追加

### 設定内容

| APIルート | 制限 | 期間 | 認証 | 実装状態 |
|:---|:---:|:---:|:---:|:---:|
| /api/upload | 10 | 1分 | ✓ | ✅ |
| /api/cards (POST) | 20 | 1分 | ✓ | ✅ |
| /api/cards (GET) | 100 | 1分 | ✓ | ✅ |
| /api/streamer/settings | 10 | 1分 | ✓ | ✅ |
| /api/gacha | 30 | 1分 | ✓ | ✅ |
| /api/auth/twitch/login | 5 | 1分 | ✗ | ✅ |
| /api/auth/twitch/callback | 10 | 1分 | ✗ | ✅ |
| /api/auth/logout | 10 | 1分 | ✓ | ✅ |
| /api/twitch/eventsub | 1000 | 1分 | ✗ | ✅ |
| グローバルミドルウェア | 1000 | 1分 | ✗ | ✅ |

### 技術仕様

#### レート制限アルゴリズム
- スライディングウィンドウ方式
- Redisまたはインメモリストレージ
- 開発環境ではインメモリ、本番環境ではRedisを推奨

#### 識別子戦略
- 認証済みユーザー: `user:{twitchUserId}`
- 未認証ユーザー: `ip:{ipAddress}`
- グローバル: `global:{ipAddress}`

#### エラーレスポンス
```json
{
  "error": "リクエストが多すぎます。しばらく待ってから再試行してください。",
  "retryAfter": 1640995200000
}
```

#### レート制限ヘッダー
- `X-RateLimit-Limit`: 制限値
- `X-RateLimit-Remaining`: 残りリクエスト数
- `X-RateLimit-Reset`: リセット時間（Unixタイムスタンプ）

### テスト

**ビルドテスト**: ✅ 成功
- TypeScriptコンパイルエラーなし
- ESLintエラーなし
- Next.jsビルド成功

**機能テスト**: 各APIルートでレート制限が正しく動作することを確認

### 備考

- 設計書 docs/ARCHITECTURE.md Issue #13 のすべての要件を満たしています
- EventSub WebhookはTwitchからの信頼できる通知であるため、制限を緩く設定しています
- グローバルミドルウェアにより、未対応のAPIルートも基本的な保護が適用されています
- フロントエンドの429エラーハンドリングにより、ユーザーエクスペリエンスが向上しています

### 環境変数

**開発環境**:
```bash
# Upstash Redis（オプション）
# UPSTASH_REDIS_REST_URL=
# UPSTASH_REDIS_REST_TOKEN=
```

**本番環境**:
- Upstash Redisの使用を推奨
- 環境変数 `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` を設定

### 変更されたファイル

- `src/middleware.ts` - グローバルレート制限を追加
- `src/components/ChannelPointSettings.tsx` - 429エラーハンドリングを追加
- `src/components/GachaHistorySection.tsx` - 429エラーハンドリングを追加
- 他のAPIルートとコンポーネントは既に実装済みであったため確認のみ