# 実装記録

## Issue #13: APIルートのレート制限実装

### 実装日
2026-01-17

### 実装内容

#### 1. 依存関係の追加
```bash
npm install @upstash/ratelimit @upstash/redis
```

#### 2. `src/lib/rate-limit.ts` の作成

レート制限機能を提供するライブラリファイルを作成:
- Redis接続の初期化（環境変数がある場合）
- インメモリストア（Redisがない場合のフォールバック）
- 各APIルート用のレート制限定義
- レート制限チェック関数
- IPアドレス取得関数
- ユーザー識別子取得関数

レート制限設定:
| API ルート | リクエスト制限 | 期間 |
|:---|:---:|:---:|
| `/api/upload` | 10 | 1分 |
| `/api/cards` (POST) | 20 | 1分 |
| `/api/cards` (GET) | 100 | 1分 |
| `/api/cards/[id]` | 100 | 1分 |
| `/api/streamer/settings` | 10 | 1分 |
| `/api/gacha` | 30 | 1分 |
| `/api/auth/twitch/login` | 5 | 1分 |
| `/api/auth/twitch/callback` | 10 | 1分 |
| `/api/auth/logout` | 10 | 1分 |
| `/api/twitch/eventsub` | 1000 | 1分 |

#### 3. 各APIルートへのレート制限適用

以下のAPIルートにレート制限チェックを追加:
- `src/app/api/upload/route.ts`
- `src/app/api/cards/route.ts`
- `src/app/api/cards/[id]/route.ts`
- `src/app/api/gacha/route.ts`
- `src/app/api/streamer/settings/route.ts`
- `src/app/api/auth/twitch/login/route.ts`
- `src/app/api/auth/twitch/callback/route.ts`
- `src/app/api/auth/logout/route.ts`
- `src/app/api/twitch/eventsub/route.ts`

各APIルートで:
1. レート制限識別子を取得（認証済みユーザーはtwitchUserId、未認証はIPアドレス）
2. レート制限をチェック
3. 制限を超過している場合は429エラーを返す
4. レート制限ヘッダーを設定（X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset）

### 技術詳細

#### ストレージ選択
- **本番環境**: Upstash Redisを使用（スケーラビリティのため）
- **開発環境**: インメモリストアを使用（設定なしで動作）

#### ユーザー識別
- 認証済みユーザー: `user:{twitchUserId}`
- 未認証ユーザー: `ip:{IPアドレス}`

#### フェイルセーフ
- レート制限チェックでエラーが発生した場合は、リクエストを許可

### 環境変数

**.env.local**:
```bash
# Upstash Redis（オプション - 使用する場合のみ）
# UPSTASH_REDIS_REST_URL=
# UPSTASH_REDIS_REST_TOKEN=
```

### 動作確認

429エラーが返される際のレスポンス例:
```json
{
  "error": "リクエストが多すぎます。しばらく待ってから再試行してください。",
  "retryAfter": 1234567890
}
```

ヘッダー:
- `X-RateLimit-Limit`: リクエスト制限数
- `X-RateLimit-Remaining`: 残りリクエスト数
- `X-RateLimit-Reset`: リセット時刻（Unixタイムスタンプ）
